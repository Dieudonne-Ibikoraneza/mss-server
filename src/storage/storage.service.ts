import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

export const PRODUCT_IMAGES_BUCKET = 'Products';
export const COLLECTION_IMAGES_BUCKET = 'Collections';
/** AI-generated room visualizations — recommendation renders and chatbot
 * room/tile preview edits alike — a separate bucket from the catalog's own
 * product/collection photos since these are generated content, not managed
 * catalog assets (see `ChatbotService`). */
export const RECOMMENDATION_IMAGES_BUCKET = 'RecommendationVisuals';
/** Customers' own room photos, uploaded for the chatbot's "put this tile on
 * my floor" preview — never AI-generated, so kept out of
 * `RECOMMENDATION_IMAGES_BUCKET` even though both feed the same feature. */
export const ROOM_PHOTOS_BUCKET = 'RoomPhotos';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
/**
 * Catalog photos and AI-generated visuals only ever get shown as a ~96px
 * sidebar thumbnail or a tiled 3D wall/floor texture — never at their
 * original resolution — so anything past this is wasted bytes the browser
 * still has to decode on every load. Uploads have arrived as raw phone
 * photos several megabytes / 5000px+ wide, which stalls the main thread
 * badly enough (competing with the visualizer's own Three.js work) that the
 * image never finishes painting and the tile just stays blank.
 */
const MAX_IMAGE_DIMENSION_PX = 1600;
const IMAGE_QUALITY = 82;

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly supabase: SupabaseClient | null;
  /** Buckets confirmed to exist this process — `ensureBucket` is otherwise a
   * network round trip on every single upload, for a check that basically
   * never needs redoing once it's passed. */
  private readonly confirmedBuckets = new Set<string>();

  constructor(private readonly config: ConfigService) {
    const driver = this.config.get<string>('storage.driver');
    const url = this.config.get<string>('storage.supabase.url');
    const serviceRoleKey = this.config.get<string>('storage.supabase.serviceRoleKey');

    this.supabase =
      driver === 'supabase' && url && serviceRoleKey
        ? createClient(url, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          })
        : null;
  }

  async uploadProductImage(file: Express.Multer.File) {
    return this.uploadImage(
      file.buffer,
      file.mimetype,
      PRODUCT_IMAGES_BUCKET,
      'products',
      'product',
    );
  }

  async uploadCollectionImage(file: Express.Multer.File) {
    return this.uploadImage(
      file.buffer,
      file.mimetype,
      COLLECTION_IMAGES_BUCKET,
      'collections',
      'collection',
    );
  }

  /**
   * Persists one AI-generated room visualization so a reloaded conversation
   * can show it again without regenerating it (a real, quota-consuming API
   * call) — returns just the bare path, the same thing `Product.image` and
   * `Recommendation.imagePath` both store, never a URL (see `getSignedUrl`).
   * Unlike the two callers above, the bucket here isn't necessarily
   * pre-provisioned by hand in the Supabase dashboard, so this creates it on
   * first use if needed. `folder` separates the two callers' outputs within
   * that one bucket ('recommendations' vs 'room-tile-previews') without
   * needing a bucket each.
   */
  async uploadGeneratedImage(
    data: Buffer,
    mimeType: string,
    folder = 'recommendations',
  ): Promise<string> {
    await this.ensureBucket(RECOMMENDATION_IMAGES_BUCKET);
    const { path } = await this.uploadImage(
      data,
      mimeType,
      RECOMMENDATION_IMAGES_BUCKET,
      folder,
      'recommendation visualization',
    );
    return path;
  }

  /**
   * The customer's own room photo, uploaded before asking the assistant to
   * preview a tile on its floor — persisted the same way as
   * `uploadGeneratedImage` (bare path back, bucket auto-created on first
   * use) so it can be re-shown on a reloaded conversation and re-sent to the
   * image model without asking the customer to upload it again.
   */
  async uploadRoomPhoto(file: Express.Multer.File) {
    await this.ensureBucket(ROOM_PHOTOS_BUCKET);
    return this.uploadImage(file.buffer, file.mimetype, ROOM_PHOTOS_BUCKET, 'rooms', 'room photo');
  }

  /**
   * Downloads a stored image's raw bytes (base64-encoded) for handing to the
   * image model directly — used for the customer's own room photo, whose
   * bucket/path we already control, unlike a catalog tile photo which is
   * fetched over HTTP from its resolved signed URL instead (see
   * `GeminiImageProvider`/`downloadReferenceImage`).
   */
  async downloadImage(
    path: string,
    bucket: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    if (!this.supabase) return null;
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    return { data: buffer.toString('base64'), mimeType: data.type || 'image/webp' };
  }

  /** Idempotent: creates the bucket if it doesn't exist yet, otherwise a no-op — safe to call before every upload. */
  private async ensureBucket(bucket: string): Promise<void> {
    if (!this.supabase || this.confirmedBuckets.has(bucket)) return;
    const { error } = await this.supabase.storage.createBucket(bucket, { public: false });
    // Supabase has no "if not exists" flag — a 409 here just means another
    // request (or a past run) already created it, which is the success case.
    if (error && !/already exists/i.test(error.message)) {
      this.logger.warn(`Could not confirm/create storage bucket "${bucket}": ${error.message}`);
      return;
    }
    this.confirmedBuckets.add(bucket);
  }

  private async uploadImage(
    buffer: Buffer,
    mimeType: string,
    bucket: string,
    folder: string,
    resourceName: string,
  ) {
    if (!this.supabase) {
      throw new ServiceUnavailableException(
        'Supabase storage is not configured. Set STORAGE_DRIVER=supabase and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }

    const { buffer: optimized, mimeType: optimizedMimeType } = await this.optimizeImage(
      buffer,
      mimeType,
    );

    const extension = optimizedMimeType.split('/')[1] ?? 'png';
    const path = `${folder}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await this.supabase.storage
      .from(bucket)
      .upload(path, optimized, {
        contentType: optimizedMimeType,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      throw new ServiceUnavailableException(
        `Unable to upload ${resourceName} image: ${uploadError.message}`,
      );
    }

    // `path` (not `url`) is what a caller should persist — see `getSignedUrl`
    // for why storing the URL itself would be a live bug, not just a caching
    // nicety. `url` here is only for the uploader's own immediate preview,
    // before the product it belongs to even exists yet to be re-fetched.
    const url = await this.getSignedUrl(path, bucket);
    return {
      bucket,
      path,
      url,
      expiresIn: SIGNED_URL_TTL_SECONDS,
      contentType: optimizedMimeType,
      size: optimized.length,
    };
  }

  /**
   * Downscales to `MAX_IMAGE_DIMENSION_PX` (never upscales) and transcodes to
   * webp — see the constants above for why. Animated sources (gif) are left
   * alone: resizing would flatten them to a single frame.
   */
  private async optimizeImage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (mimeType === 'image/gif') {
      return { buffer, mimeType };
    }

    try {
      const optimized = await sharp(buffer)
        .resize({
          width: MAX_IMAGE_DIMENSION_PX,
          height: MAX_IMAGE_DIMENSION_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: IMAGE_QUALITY })
        .toBuffer();
      return { buffer: optimized, mimeType: 'image/webp' };
    } catch (error) {
      this.logger.warn(`Could not optimize image, uploading original: ${(error as Error).message}`);
      return { buffer, mimeType };
    }
  }

  /**
   * Resolves a stored blob path (e.g. "products/<uuid>.png") to a signed,
   * time-limited URL — the bucket is private, so this is the *only* way any
   * of its objects are ever reachable, and there's no bucket-listing
   * endpoint exposed either: knowing the exact path (itself a random UUID)
   * is the only way in. Called fresh on every product read (`ProductsService`
   * caches the whole serialized product for 60s in Redis, comfortably under
   * this URL's own lifetime, so this only actually hits Supabase on a cache
   * miss) rather than once at upload time, since a URL stored permanently in
   * the database would silently die the moment it expired.
   */
  async getSignedUrl(path: string, bucket = PRODUCT_IMAGES_BUCKET): Promise<string> {
    if (!this.supabase) {
      throw new ServiceUnavailableException(
        'Supabase storage is not configured. Set STORAGE_DRIVER=supabase and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }

    const { data, error } = await this.supabase.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      throw new ServiceUnavailableException(
        `Could not create an access URL for "${path}": ${error?.message ?? 'unknown error'}`,
      );
    }

    return data.signedUrl;
  }
}

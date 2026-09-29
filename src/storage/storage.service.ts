import { Injectable, Logger } from '@nestjs/common';
import { notFound, serviceUnavailable } from '@/common/errors/app-error';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fetchPublicFile } from '@/common/utils/safe-url';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { MinioStorage } from './minio-storage';

export const PRODUCT_IMAGES_BUCKET = 'Products';
export const COLLECTION_IMAGES_BUCKET = 'Collections';
export const ROOM_THUMBNAILS_BUCKET = 'RoomThumbnails';
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
const OBJECT_REFERENCE_PREFIX = 'mss-object:';
const IMAGE_BUCKETS = new Set([
  PRODUCT_IMAGES_BUCKET,
  COLLECTION_IMAGES_BUCKET,
  ROOM_THUMBNAILS_BUCKET,
  RECOMMENDATION_IMAGES_BUCKET,
  ROOM_PHOTOS_BUCKET,
]);
const SIGNED_URL_CACHE_SECONDS = 50 * 60;
const MAX_CONCURRENT_SIGNED_URL_REQUESTS = 8;
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
  private readonly minio: MinioStorage | null;
  /** Buckets confirmed to exist this process — `ensureBucket` is otherwise a
   * network round trip on every single upload, for a check that basically
   * never needs redoing once it's passed. */
  private readonly confirmedBuckets = new Set<string>();
  /** Signed URLs are reused across the several dashboard queries that render the same catalogue. */
  private readonly signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
  /** Multiple concurrent responses often ask for the same image; share one provider request. */
  private readonly signedUrlInFlight = new Map<string, Promise<string>>();
  private signedUrlRequests = 0;
  private readonly signedUrlWaiters: (() => void)[] = [];

  constructor(private readonly config: ConfigService) {
    const driver = this.config.get<string>('storage.driver');
    this.minio = driver === 'minio' ? new MinioStorage(this.config) : null;
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
    const uploaded = await this.uploadImage(
      file.buffer,
      file.mimetype,
      PRODUCT_IMAGES_BUCKET,
      'products',
      'product',
    );
    return {
      path: uploaded.path,
      url: uploaded.url,
      contentType: uploaded.contentType,
      size: uploaded.size,
    };
  }

  private productImageKey(): Buffer {
    const secret = this.config.get<string>('jwt.accessSecret');
    if (!secret)
      throw serviceUnavailable('storage.notConfigured', 'File storage is not configured.');
    return createHash('sha256').update(`product-image:${secret}`).digest();
  }

  /** Opaque application URL: storage hosts and paths never reach the browser. */
  private productImageUrl(source: string, bucket = PRODUCT_IMAGES_BUCKET): string {
    const key = `product-proxy:${bucket}:${source}`;
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.productImageKey(), iv);
    // Keep existing catalog tokens compatible. Other private images get an
    // expiring bucket/path reference, proxied by the same application endpoint.
    const reference =
      bucket === PRODUCT_IMAGES_BUCKET
        ? source
        : `${OBJECT_REFERENCE_PREFIX}${JSON.stringify({
            bucket,
            path: source,
            expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
          })}`;
    const encrypted = Buffer.concat([cipher.update(reference, 'utf8'), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    const origin = (this.config.get<string>('app.clientUrl') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    const url = `${origin}/api/product-images/${token}`;
    this.signedUrlCache.set(key, { url, expiresAt: Date.now() + SIGNED_URL_CACHE_SECONDS * 1000 });
    return url;
  }

  private decodeProductImageToken(token: string): string {
    try {
      if (!/^[A-Za-z0-9_-]{39,4096}$/.test(token)) throw new Error('Invalid token');
      const data = Buffer.from(token, 'base64url');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.productImageKey(),
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw notFound('storage.imageNotFound', 'Image not found.');
    }
  }

  /** Recover the persisted reference when an editor sends back an application URL. */
  productImageSource(image: string): string {
    const proxy = /\/api\/product-images\/([A-Za-z0-9_-]+)(?:\?|$)/.exec(image);
    if (proxy) return this.decodeProductImageToken(proxy[1]);
    return this.extractOwnSignedPath(image) ?? image;
  }

  async getProductImageBlob(token: string): Promise<Blob> {
    const source = this.decodeProductImageToken(token);
    if (!source.startsWith(OBJECT_REFERENCE_PREFIX)) return this.downloadProductBlob(source);
    const reference = this.decodeObjectReference(source);
    return this.validateImageBlob(await this.downloadStoredBlob(reference.path, reference.bucket));
  }

  private decodeObjectReference(source: string): { bucket: string; path: string } {
    try {
      const reference = JSON.parse(source.slice(OBJECT_REFERENCE_PREFIX.length)) as {
        bucket?: unknown;
        path?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof reference.bucket !== 'string' ||
        !IMAGE_BUCKETS.has(reference.bucket) ||
        typeof reference.path !== 'string' ||
        typeof reference.expiresAt !== 'number' ||
        reference.expiresAt <= Date.now()
      ) {
        throw new Error('Invalid or expired image reference.');
      }
      return { bucket: reference.bucket, path: reference.path };
    } catch {
      throw notFound('storage.imageNotFound', 'Image not found.');
    }
  }

  private async downloadStoredBlob(path: string, bucket: string): Promise<Blob> {
    if (!this.supabase && !this.minio) {
      throw serviceUnavailable('storage.notConfigured', 'File storage is not configured.');
    }
    try {
      if (this.minio) return await this.minio.download(bucket, path);
      const { data, error } = await this.supabase!.storage.from(bucket).download(path);
      if (error || !data) throw error ?? new Error('Storage returned no file.');
      return data;
    } catch (error) {
      this.logStorageFailure('Could not download storage image', error);
      throw serviceUnavailable(
        'storage.accessUrlFailed',
        'Could not open this file right now. Please try again.',
      );
    }
  }

  private validateImageBlob(blob: Blob): Blob {
    if (
      !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(blob.type) ||
      blob.size > 20 * 1024 * 1024
    ) {
      throw notFound('storage.imageNotFound', 'Image not found.');
    }
    return blob;
  }

  /** Internal image generation reads bytes directly, without visiting the frontend proxy. */
  async downloadProductReference(
    image: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    try {
      const blob = await this.downloadProductBlob(image);
      return {
        data: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        mimeType: blob.type,
      };
    } catch {
      return null;
    }
  }

  private async downloadProductBlob(image: string): Promise<Blob> {
    const source = this.productImageSource(image);
    let blob: Blob;
    if (/^https?:\/\//i.test(source)) {
      const file = await fetchPublicFile(source, { timeoutMs: 20_000, maxBytes: 20 * 1024 * 1024 });
      if (!file) throw notFound('storage.imageNotFound', 'Image not found.');
      blob = new Blob([new Uint8Array(file.buffer)], { type: file.contentType });
    } else {
      blob = await this.downloadStoredBlob(source, PRODUCT_IMAGES_BUCKET);
    }
    return this.validateImageBlob(blob);
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

  async uploadRoomThumbnail(file: Express.Multer.File) {
    await this.ensureBucket(ROOM_THUMBNAILS_BUCKET);
    return this.uploadImage(
      file.buffer,
      file.mimetype,
      ROOM_THUMBNAILS_BUCKET,
      'rooms',
      'room thumbnail',
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
  async uploadRoomPhoto(file: Express.Multer.File, ownerId: string) {
    await this.ensureBucket(ROOM_PHOTOS_BUCKET);
    // Filed under the owner's id, so a path alone says whose photo it is.
    return this.uploadImage(
      file.buffer,
      file.mimetype,
      ROOM_PHOTOS_BUCKET,
      `rooms/${ownerId}`,
      'room photo',
    );
  }

  private describeError(error: unknown, depth = 0): unknown {
    if (depth > 2) return '[cause depth limit]';
    if (error instanceof Error) {
      const details = error as NodeJS.ErrnoException;
      return {
        name: error.name,
        message: error.message,
        code: details.code,
        syscall: details.syscall,
        cause: error.cause === undefined ? undefined : this.describeError(error.cause, depth + 1),
      };
    }
    if (typeof error === 'string' || typeof error === 'number') return error;
    return undefined;
  }

  private logStorageFailure(action: string, error: unknown): void {
    const details = error as {
      message?: string;
      name?: string;
      status?: number;
      statusCode?: string;
      code?: string;
      originalError?: unknown;
      cause?: unknown;
    } | null;
    const original = details?.originalError ?? details?.cause;
    const originalError = original instanceof Error ? original : undefined;
    this.logger.error(
      `${action}: ${JSON.stringify({
        message: details?.message,
        name: details?.name,
        status: details?.status,
        statusCode: details?.statusCode,
        code: details?.code,
        cause: this.describeError(original),
      })}`,
      originalError?.stack,
    );
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
    try {
      const data = await this.downloadStoredBlob(path, bucket);
      const buffer = Buffer.from(await data.arrayBuffer());
      return { data: buffer.toString('base64'), mimeType: data.type || 'image/webp' };
    } catch {
      return null;
    }
  }

  /** Idempotent: creates the bucket if it doesn't exist yet, otherwise a no-op — safe to call before every upload. */
  private async ensureBucket(bucket: string): Promise<void> {
    // MinIO ensures its single physical bucket inside upload(), where provider
    // failures are caught and translated to the same upload error as Supabase.
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
    if (!this.supabase && !this.minio) {
      throw serviceUnavailable(
        'storage.notConfigured',
        'File storage is not set up on this server. Please contact the administrator.',
      );
    }

    const { buffer: optimized, mimeType: optimizedMimeType } = await this.optimizeImage(
      buffer,
      mimeType,
    );

    const extension = optimizedMimeType.split('/')[1] ?? 'png';
    const path = `${folder}/${crypto.randomUUID()}.${extension}`;
    try {
      if (this.minio) {
        await this.minio.upload(bucket, path, optimized, optimizedMimeType);
      } else {
        const { error } = await this.supabase!.storage.from(bucket).upload(path, optimized, {
          contentType: optimizedMimeType,
          cacheControl: '3600',
          upsert: false,
        });
        if (error) throw error;
      }
    } catch (uploadError) {
      // StorageUnknownError keeps the original fetch exception, including Node's
      // nested system error (ECONNRESET, ETIMEDOUT, EAI_AGAIN, etc.). Logging
      // only `message` collapses all of those into the unhelpful "fetch failed".
      this.logStorageFailure(`Unable to upload ${resourceName} image`, uploadError);
      throw serviceUnavailable(
        'storage.uploadFailed',
        'Unable to upload the {{resource}} image. Please try again.',
        {
          resource: resourceName,
        },
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
    if (bucket === PRODUCT_IMAGES_BUCKET)
      return this.productImageUrl(this.productImageSource(path));
    if (this.minio) {
      if (!IMAGE_BUCKETS.has(bucket)) throw notFound('storage.imageNotFound', 'Image not found.');
      return this.productImageUrl(path, bucket);
    }
    if (!this.supabase) {
      throw serviceUnavailable(
        'storage.notConfigured',
        'File storage is not set up on this server. Please contact the administrator.',
      );
    }

    const key = `${bucket}:${path}`;
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const existing = this.signedUrlInFlight.get(key);
    if (existing) return existing;

    const request = this.createSignedUrl(path, bucket, key);
    this.signedUrlInFlight.set(key, request);
    return request;
  }

  private async createSignedUrl(path: string, bucket: string, key: string): Promise<string> {
    await this.acquireSignedUrlSlot();
    try {
      const { data, error } = await this.supabase!.storage.from(bucket).createSignedUrl(
        path,
        SIGNED_URL_TTL_SECONDS,
      );

      if (error || !data?.signedUrl) {
        this.logStorageFailure(
          `Could not create an access URL for "${path}"`,
          error ?? new Error('Storage returned no signed URL.'),
        );
        throw serviceUnavailable(
          'storage.accessUrlFailed',
          'Could not open this file right now. Please try again.',
        );
      }

      this.signedUrlCache.set(key, {
        url: data.signedUrl,
        expiresAt: Date.now() + SIGNED_URL_CACHE_SECONDS * 1000,
      });
      return data.signedUrl;
    } finally {
      this.releaseSignedUrlSlot();
      this.signedUrlInFlight.delete(key);
    }
  }

  private acquireSignedUrlSlot(): Promise<void> {
    if (this.signedUrlRequests < MAX_CONCURRENT_SIGNED_URL_REQUESTS) {
      this.signedUrlRequests += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.signedUrlWaiters.push(resolve));
  }

  private releaseSignedUrlSlot(): void {
    const next = this.signedUrlWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.signedUrlRequests = Math.max(0, this.signedUrlRequests - 1);
  }

  /**
   * Resolves a product/collection's stored `image` value to something a
   * client can actually load: either an absolute URL as-is (seeded/external
   * catalog photos), or a bare blob path (e.g. "products/<uuid>.png",
   * possibly recovered from a stale signed URL saved by mistake) freshly
   * re-signed via `getSignedUrl` — see that method's own doc for why a
   * signed URL is never persisted or trusted from storage. Shared by every
   * caller that serializes a product/tile for a response (`ProductsService`,
   * `AnalyticsService`) so none of them can drift from this resolution and
   * hand back a dead/unsigned path by omission.
   */
  async resolveImageUrl(image: string, bucket = PRODUCT_IMAGES_BUCKET): Promise<string> {
    if (bucket === PRODUCT_IMAGES_BUCKET)
      return this.productImageUrl(this.productImageSource(image));
    const selfSignedPath = this.extractOwnSignedPath(image);
    if (selfSignedPath) return this.getSignedUrl(selfSignedPath, bucket);
    if (/^https?:\/\//i.test(image)) return image;
    return this.getSignedUrl(image, bucket);
  }

  /** Extracts the bare object path out of one of our own Supabase Storage signed URLs, or `null` if `value` isn't one. */
  private extractOwnSignedPath(value: string): string | null {
    const match = /\/storage\/v1\/object\/sign\/[^/]+\/(.+?)(?:\?|$)/.exec(value);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

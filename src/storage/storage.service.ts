import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const PRODUCT_IMAGES_BUCKET = 'Products';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

@Injectable()
export class StorageService {
  private readonly supabase: SupabaseClient | null;

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
    if (!this.supabase) {
      throw new ServiceUnavailableException(
        'Supabase storage is not configured. Set STORAGE_DRIVER=supabase and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }

    const extension = file.mimetype.split('/')[1];
    const path = `products/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await this.supabase.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      throw new ServiceUnavailableException(
        `Unable to upload product image: ${uploadError.message}`,
      );
    }

    // `path` (not `url`) is what a caller should persist — see `getSignedUrl`
    // for why storing the URL itself would be a live bug, not just a caching
    // nicety. `url` here is only for the uploader's own immediate preview,
    // before the product it belongs to even exists yet to be re-fetched.
    const url = await this.getSignedUrl(path);
    return {
      bucket: PRODUCT_IMAGES_BUCKET,
      path,
      url,
      expiresIn: SIGNED_URL_TTL_SECONDS,
      contentType: file.mimetype,
      size: file.size,
    };
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
  async getSignedUrl(path: string): Promise<string> {
    if (!this.supabase) {
      throw new ServiceUnavailableException(
        'Supabase storage is not configured. Set STORAGE_DRIVER=supabase and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }

    const { data, error } = await this.supabase.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      throw new ServiceUnavailableException(
        `Could not create an access URL for "${path}": ${error?.message ?? 'unknown error'}`,
      );
    }

    return data.signedUrl;
  }
}

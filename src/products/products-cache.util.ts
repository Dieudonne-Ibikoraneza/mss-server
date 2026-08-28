import { RedisService } from '@/redis/redis.service';

export const PRODUCTS_LIST_CACHE_PREFIX = 'cache:products:list:';
export const productDetailCachePrefix = (productId: string) =>
  `cache:products:detail:${productId}:`;

/** Call after any write that changes a product's fields, price, or stock (inventory adjustments, order-driven reservations). */
export async function invalidateProductsCache(
  redis: RedisService,
  productIds: string[],
): Promise<void> {
  await Promise.all([
    redis.delByPrefix(PRODUCTS_LIST_CACHE_PREFIX),
    ...productIds.map((id) => redis.delByPrefix(productDetailCachePrefix(id))),
  ]);
}

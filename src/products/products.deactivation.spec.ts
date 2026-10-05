import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { StorageService } from '@/storage/storage.service';
import { OrdersService } from '@/orders/orders.service';
import { TranslationService } from '@/translation/translation.service';
import { ProductsService } from './products.service';
import { Role } from '@prisma/client';
import { ProductsController } from './products.controller';
import { PRODUCTS_LIST_CACHE_PREFIX, productDetailCachePrefix } from './products-cache.util';

describe('product deactivation', () => {
  const update = jest.fn().mockResolvedValue({ id: 'tile' });
  const findUnique = jest.fn();
  const delByPrefix = jest.fn().mockResolvedValue(0);
  let service: ProductsService;

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({ id: 'tile' });
    update.mockResolvedValue({ id: 'tile', isActive: true, recommendationExcluded: true });
    service = new ProductsService(
      { product: { update, findUnique } } as unknown as PrismaService,
      { delByPrefix } as unknown as RedisService,
      {} as NotificationsService,
      {} as StorageService,
      {} as OrdersService,
      {} as TranslationService,
    );
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ id: 'tile' } as unknown as Awaited<
        ReturnType<ProductsService['findOne']>
      >);
  });

  it('deactivates and excludes a tile together, then clears its cached catalog state', async () => {
    await service.remove('tile');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'tile' },
      data: { isActive: false, recommendationExcluded: true },
    });
    expect(delByPrefix).toHaveBeenCalledWith(PRODUCTS_LIST_CACHE_PREFIX);
    expect(delByPrefix).toHaveBeenCalledWith(productDetailCachePrefix('tile'));
    expect(delByPrefix).toHaveBeenCalledWith('cache:collections:list:');
    expect(delByPrefix).toHaveBeenCalledWith('cache:collections:detail:v2:');
  });

  it('does not modify tiles or caches when the product is missing', async () => {
    jest.spyOn(service, 'findOne').mockRejectedValue(new Error('Product not found.'));
    await expect(service.remove('missing')).rejects.toThrow('Product not found.');
    expect(update).not.toHaveBeenCalled();
    expect(delByPrefix).not.toHaveBeenCalled();
  });

  it('reactivates a tile while retaining its recommendation exclusion and refreshing catalog caches', async () => {
    expect(await service.reactivate('tile')).toEqual({
      id: 'tile',
      isActive: true,
      recommendationExcluded: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'tile' },
      data: { isActive: true },
      select: { id: true, isActive: true, recommendationExcluded: true },
    });
    expect(delByPrefix).toHaveBeenCalledWith(PRODUCTS_LIST_CACHE_PREFIX);
    expect(delByPrefix).toHaveBeenCalledWith(productDetailCachePrefix('tile'));
    expect(delByPrefix).toHaveBeenCalledWith('cache:collections:list:');
    expect(delByPrefix).toHaveBeenCalledWith('cache:collections:detail:v2:');
  });

  it('rejects reactivation of a missing tile without writes or cache changes', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.reactivate('missing')).rejects.toThrow('Product not found.');
    expect(update).not.toHaveBeenCalled();
    expect(delByPrefix).not.toHaveBeenCalled();
  });

  it('restricts the reactivation endpoint to admins and stock managers', () => {
    const handler = Object.getOwnPropertyDescriptor(ProductsController.prototype, 'reactivate')!
      .value as object;
    expect(Reflect.getMetadata('roles', handler)).toEqual([Role.ADMIN, Role.STOCK_MANAGER]);
    expect(Reflect.getMetadata('isPublic', handler)).toBeUndefined();
  });
});

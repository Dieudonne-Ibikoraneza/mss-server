import { Prisma, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { StorageService } from '@/storage/storage.service';
import { OrdersService } from '@/orders/orders.service';
import { TranslationService } from '@/translation/translation.service';
import { ProductsService } from './products.service';
import { ProductCatalogStatus, QueryProductsDto } from './dto/query-products.dto';

describe('inventory catalog visibility', () => {
  const findMany = jest.fn<Promise<never[]>, [Prisma.ProductFindManyArgs]>();
  const count = jest.fn<Promise<number>, [Prisma.ProductCountArgs]>();
  const get = jest.fn();
  const set = jest.fn();
  let service: ProductsService;

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
    get.mockResolvedValue(null);
    set.mockResolvedValue(undefined);
    service = new ProductsService(
      {
        product: { findMany, count },
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { get, set } as unknown as RedisService,
      {} as NotificationsService,
      {} as StorageService,
      {} as OrdersService,
      {} as TranslationService,
    );
  });

  it.each([undefined, Role.CLIENT, Role.SALES_PERSON, Role.DATA_ANALYST])(
    'keeps the default catalog active-only for %s',
    async (role) => {
      await service.findAll(new QueryProductsDto(), role);
      expect(findMany.mock.calls[0][0].where?.isActive).toBe(true);
    },
  );

  it.each([Role.ADMIN, Role.STOCK_MANAGER])(
    'lets %s browse all or only inactive inventory',
    async (role) => {
      for (const catalogStatus of [ProductCatalogStatus.ALL, ProductCatalogStatus.INACTIVE]) {
        await service.findAll(plainToInstance(QueryProductsDto, { catalogStatus }), role);
        const activity = catalogStatus === ProductCatalogStatus.ALL ? undefined : false;
        expect(findMany.mock.calls.at(-1)?.[0].where?.isActive).toBe(activity);
        expect(count.mock.calls.at(-1)?.[0].where?.isActive).toBe(activity);
      }
    },
  );

  it.each([undefined, Role.CLIENT, Role.SALES_PERSON, Role.DATA_ANALYST])(
    'rejects inactive inventory access for %s before reading caches',
    async (role) => {
      for (const catalogStatus of [ProductCatalogStatus.ALL, ProductCatalogStatus.INACTIVE]) {
        await expect(
          service.findAll(plainToInstance(QueryProductsDto, { catalogStatus }), role),
        ).rejects.toThrow('Inactive tiles are available only to admins and stock managers.');
      }
      expect(get).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('separates active, inactive and combined inventory in cache keys', async () => {
    for (const catalogStatus of Object.values(ProductCatalogStatus)) {
      await service.findAll(plainToInstance(QueryProductsDto, { catalogStatus }), Role.ADMIN);
      expect(get).toHaveBeenLastCalledWith(
        expect.stringContaining(`catalogStatus=${catalogStatus}`),
      );
    }
    const keys = get.mock.calls.map(([key]) => key as string);
    expect(new Set(keys).size).toBe(3);
  });

  it('validates the catalog status filter', async () => {
    expect(
      await validate(plainToInstance(QueryProductsDto, { catalogStatus: 'deleted' })),
    ).not.toHaveLength(0);
    for (const catalogStatus of Object.values(ProductCatalogStatus)) {
      expect(await validate(plainToInstance(QueryProductsDto, { catalogStatus }))).toHaveLength(0);
    }
  });
});

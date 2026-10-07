import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { StorageService } from '@/storage/storage.service';
import { TranslationService } from '@/translation/translation.service';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { CollectionCatalogStatus, QueryCollectionsDto } from './dto/query-collections.dto';

describe('collection catalog visibility', () => {
  const findMany = jest.fn<Promise<never[]>, [Prisma.CollectionFindManyArgs]>();
  const count = jest.fn<Promise<number>, [Prisma.CollectionCountArgs]>();
  const get = jest.fn<Promise<unknown>, [string]>();
  const set = jest.fn();
  let service: CollectionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
    get.mockResolvedValue(null);
    set.mockResolvedValue(undefined);
    service = new CollectionsService(
      { collection: { findMany, count } } as unknown as PrismaService,
      { get, set } as unknown as RedisService,
      {} as StorageService,
      {} as TranslationService,
    );
  });

  it.each([undefined, ...Object.values(Role)])(
    'defaults to active collections for %s',
    async (role) => {
      await service.findAll(new QueryCollectionsDto(), role);
      expect(findMany.mock.calls[0][0].where?.isActive).toBe(true);
      expect(count.mock.calls[0][0].where?.isActive).toBe(true);
    },
  );

  it.each([Role.ADMIN, Role.STOCK_MANAGER])(
    'lets %s list inactive and combined collections',
    async (role) => {
      for (const catalogStatus of [CollectionCatalogStatus.ALL, CollectionCatalogStatus.INACTIVE]) {
        await service.findAll(plainToInstance(QueryCollectionsDto, { catalogStatus }), role);
        const activity = catalogStatus === CollectionCatalogStatus.ALL ? undefined : false;
        expect(findMany.mock.calls.at(-1)?.[0].where?.isActive).toBe(activity);
        expect(count.mock.calls.at(-1)?.[0].where?.isActive).toBe(activity);
      }
    },
  );

  it.each([undefined, Role.CLIENT, Role.SALES_PERSON, Role.DATA_ANALYST])(
    'rejects inactive collection access for %s even when staff results are cached',
    async (role) => {
      get.mockResolvedValue({ items: [{ id: 'inactive', isActive: false }] });
      for (const catalogStatus of [CollectionCatalogStatus.ALL, CollectionCatalogStatus.INACTIVE]) {
        await expect(
          service.findAll(plainToInstance(QueryCollectionsDto, { catalogStatus }), role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(get).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('uses separate cache keys for active, inactive and combined collections', async () => {
    for (const catalogStatus of Object.values(CollectionCatalogStatus)) {
      await service.findAll(plainToInstance(QueryCollectionsDto, { catalogStatus }), Role.ADMIN);
    }
    expect(new Set(get.mock.calls.map(([key]) => key)).size).toBe(3);
  });

  it('forwards the authenticated viewer role from the list controller', async () => {
    const query = plainToInstance(QueryCollectionsDto, {
      catalogStatus: CollectionCatalogStatus.ALL,
    });
    const findAll = jest.spyOn(service, 'findAll');
    const controller = new CollectionsController(service, {} as StorageService);
    await controller.findAll(query, { role: Role.ADMIN } as never);
    expect(findAll).toHaveBeenCalledWith(query, Role.ADMIN);
  });

  it('validates collection catalog status', async () => {
    expect(
      await validate(plainToInstance(QueryCollectionsDto, { catalogStatus: 'deleted' })),
    ).not.toHaveLength(0);
    for (const catalogStatus of Object.values(CollectionCatalogStatus)) {
      expect(await validate(plainToInstance(QueryCollectionsDto, { catalogStatus }))).toHaveLength(
        0,
      );
    }
  });
});

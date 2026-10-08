import { Prisma, Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { QueryProductsDto } from './dto/query-products.dto';
import { CollectionsService } from '@/collections/collections.service';
import { OrdersService } from '@/orders/orders.service';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';

const product = {
  id: 'tile',
  name: 'Tile',
  image: 'tile.webp',
  currency: 'RWF',
  price: new Prisma.Decimal(1000),
  boxCoverageSqm: new Prisma.Decimal(1.44),
  piecesPerBox: 16,
  quantityOnHandSqm: new Prisma.Decimal(10),
  reservedAreaSqm: new Prisma.Decimal(8),
  averageCostPrice: new Prisma.Decimal(42),
  collection: {
    id: 'collection',
    title: 'Collection',
    slug: 'collection',
    size: '30×30cm',
    tileAreaSqm: new Prisma.Decimal(0.09),
  },
};
const privateFields = ['reservedAreaSqm', 'averageCostPrice', 'inventoryValue'];

describe('sales product stock visibility', () => {
  const cache = new Map<string, unknown>();
  const findUnique = jest.fn();
  const findMany = jest.fn();
  let service: ProductsService;

  beforeEach(() => {
    jest.clearAllMocks();
    cache.clear();
    findUnique.mockResolvedValue(product);
    findMany.mockResolvedValue([product]);
    service = new ProductsService(
      {
        product: { findUnique, findMany, count: jest.fn().mockResolvedValue(1) },
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      {
        get: (key: string) => Promise.resolve(cache.get(key) ?? null),
        set: (key: string, value: unknown) => {
          cache.set(key, value);
          return Promise.resolve();
        },
      } as never,
      {} as never,
      { resolveImageUrl: (value: string) => Promise.resolve(value) } as never,
      {} as never,
      {} as never,
    );
  });

  it('shows physical stock in the list, detail and embedded products without internal inventory details', async () => {
    const list = await service.findAll(new QueryProductsDto(), Role.SALES_PERSON);
    const detail = await service.findOne('tile', Role.SALES_PERSON);
    const embedded = await service.serializeEmbedded([product] as never, Role.SALES_PERSON);
    for (const row of [list.items[0], detail, embedded[0]]) {
      expect(row.quantityOnHandSqm).toBe(10);
      expect(row.onHandBreakdown?.totalPieces).toBe(111);
      for (const field of privateFields) expect(row).not.toHaveProperty(field);
    }
  });

  it.each([undefined, Role.CLIENT])('keeps exact quantities private for %s', async (role) => {
    const row = await service.findOne('tile', role);
    expect(row).not.toHaveProperty('quantityOnHandSqm');
    expect(row).not.toHaveProperty('onHandBreakdown');
    for (const field of privateFields) expect(row).not.toHaveProperty(field);
  });

  it.each([Role.ADMIN, Role.STOCK_MANAGER, Role.DATA_ANALYST])(
    'preserves the full inventory view for %s',
    async (role) => {
      const row = await service.findOne('tile', role);
      expect(row).toMatchObject({
        quantityOnHandSqm: 10,
        reservedAreaSqm: 8,
        averageCostPrice: 42,
        inventoryValue: 420,
      });
    },
  );

  it('isolates sales caches from full staff caches for both list and detail reads', async () => {
    for (const role of [Role.ADMIN, Role.SALES_PERSON, Role.CLIENT]) {
      await service.findOne('tile', role);
      await service.findAll(new QueryProductsDto(), role);
    }
    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenCalledTimes(3);
    const detail = await service.findOne('tile', Role.SALES_PERSON);
    const list = await service.findAll(new QueryProductsDto(), Role.SALES_PERSON);
    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const row of [detail, list.items[0]]) {
      expect(row.quantityOnHandSqm).toBe(10);
      for (const field of privateFields) expect(row).not.toHaveProperty(field);
    }
  });
});

describe('nested product stock visibility', () => {
  it('returns sales quantities from collections without reserved amounts or costs', async () => {
    const service = new CollectionsService(
      {
        collection: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'collection', image: null, products: [product] }),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.findOne('collection', Role.SALES_PERSON);
    expect(result.products[0]).toMatchObject({ quantityOnHandSqm: 10 });
    for (const field of privateFields) expect(result.products[0]).not.toHaveProperty(field);
  });

  it.each([Role.SALES_PERSON, Role.CLIENT])(
    'sanitizes products nested in orders for %s',
    async (role) => {
      const service = new OrdersService(
        {
          order: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'order',
              customerId: 'customer',
              items: [{ product: { ...product, inventoryValue: 420 } }],
              statusEvents: [],
            }),
          },
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { resolveImageUrl: (value: string) => Promise.resolve(value) } as never,
      );
      const result = await service.findOne('order', { id: 'customer', role } as AuthenticatedUser);
      const row = result.items[0].product;
      if (role === Role.SALES_PERSON) expect(row?.quantityOnHandSqm).toBe(10);
      else expect(row).not.toHaveProperty('quantityOnHandSqm');
      for (const field of privateFields) expect(row).not.toHaveProperty(field);
    },
  );
});

import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, RoomType, SuitableFor, StockMovementType } from '@prisma/client';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { QueryMovementsDto } from './dto/query-movements.dto';
import { QueryStockExportDto } from './dto/query-stock-export.dto';

type Query = {
  where?: {
    createdAt?: { gte: Date; lt: Date };
    type?: StockMovementType;
    productId?: string;
    product?: { collectionId: string };
  };
  skip?: number;
  take?: number;
};
const collectionId = '96838e5e-f555-4a77-9e39-bd0c84db91a5';
type ItemFilter = { productId?: string; product?: { collectionId: string } };
const matchesItem = (
  item: { productId: string; product: { collectionId: string } },
  filter?: ItemFilter,
) =>
  !filter ||
  ((!filter.productId || item.productId === filter.productId) &&
    (!filter.product || item.product.collectionId === filter.product.collectionId));
const productId = 'd8ddc722-9907-4d55-84c3-16c37926cd13';
const at = new Date('2026-10-05T12:00:00Z');
const movements = Array.from({ length: 25 }, (_, index) => ({
  id: `movement-${index}`,
  productId,
  createdAt: at,
  type: index % 2 ? StockMovementType.OUTBOUND : StockMovementType.INBOUND,
  changeAreaSqm: index % 2 ? -2 : 3,
  product: { id: productId, name: 'Tile', sku: 'TILE', collectionId },
  adjustedBy: { id: 'staff', fullName: 'Stock Manager' },
}));

describe('complete stock report exports', () => {
  const findMovements = jest.fn<Promise<typeof movements>, [Query]>();
  const findOrders = jest.fn();
  const findProducts = jest.fn();
  const groupOrders = jest.fn();
  const findCollection = jest.fn();
  let service: ReportsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T12:00:00Z'));
    jest.clearAllMocks();
    findMovements.mockImplementation((query: Query) => {
      const range = query.where?.createdAt;
      const rows = [
        ...movements,
        { ...movements[0], id: 'older', createdAt: new Date('2026-08-01') },
      ]
        .filter((row) => !range || (row.createdAt >= range.gte && row.createdAt < range.lt))
        .filter((row) => !query.where?.type || row.type === query.where.type)
        .filter((row) => !query.where?.productId || row.productId === query.where.productId)
        .filter(
          (row) =>
            !query.where?.product || row.product.collectionId === query.where.product.collectionId,
        );
      return Promise.resolve(
        rows.slice(
          query.skip ?? 0,
          query.take === undefined ? undefined : (query.skip ?? 0) + query.take,
        ),
      );
    });
    const orders = Array.from({ length: 25 }, (_, index) => ({
      id: `order-${index}`,
      items: [
        {
          productId: index % 2 ? 'other' : productId,
          totalPieces: 3,
          product: { collectionId: index % 2 ? 'other-collection' : collectionId },
        },
        { productId: 'unrelated', totalPieces: 99, product: { collectionId: 'other-collection' } },
        ...(index === 1
          ? [{ productId: 'tile-1', totalPieces: 5, product: { collectionId } }]
          : []),
      ],
    }));
    findOrders.mockImplementation(
      (query: {
        take?: number;
        where?: { items?: { some: ItemFilter } };
        include?: { items?: { where?: ItemFilter } };
      }) => {
        const selected = query.where?.items?.some;
        return Promise.resolve(
          orders
            .filter((row) => row.items.some((item) => matchesItem(item, selected)))
            .slice(0, query.take)
            .map((row) => ({
              ...row,
              items: row.items.filter((item) => matchesItem(item, query.include?.items?.where)),
            })),
        );
      },
    );
    groupOrders.mockImplementation((query: { where: { items?: { some: ItemFilter } } }) => {
      const selected = query.where.items?.some;
      return Promise.resolve([
        {
          status: 'PENDING',
          _count: {
            _all: orders.filter((row) => row.items.some((item) => matchesItem(item, selected)))
              .length,
          },
        },
      ]);
    });
    const products = Array.from({ length: 30 }, (_, index) => ({
      id: index === 0 ? productId : `tile-${index}`,
      name: 'Tile',
      sku: `TILE-${index}`,
      image: 'tile.webp',
      isActive: true,
      quantityOnHandSqm: 5,
      averageCostPrice: 4,
      price: 9999,
      updatedAt: at,
      roomTypes: [RoomType.LIVING_ROOM],
      suitableFor: SuitableFor.FLOOR,
      collectionId: index < 2 ? collectionId : 'other-collection',
      collection: {
        id: index < 2 ? collectionId : 'other-collection',
        title: 'Floor Tiles',
        size: '30×30cm',
        isActive: true,
      },
    }));
    findProducts.mockImplementation(
      (query: { where?: { id?: string; isActive?: boolean; collectionId?: string } }) =>
        Promise.resolve(
          products
            .filter((row) => !query.where?.id || row.id === query.where.id)
            .filter(
              (row) => !query.where?.collectionId || row.collectionId === query.where.collectionId,
            )
            .filter(
              (row) => query.where?.isActive === undefined || row.isActive === query.where.isActive,
            ),
        ),
    );
    findCollection.mockResolvedValue({
      id: collectionId,
      title: 'Floor Tiles',
      size: '30×30cm',
      isActive: true,
      _count: { products: 2 },
    });
    service = new ReportsService(
      {
        stockAdjustment: { findMany: findMovements },
        product: { findMany: findProducts },
        collection: {
          findUnique: findCollection,
          findMany: jest.fn().mockResolvedValue([
            {
              id: collectionId,
              title: 'Floor Tiles',
              size: '30×30cm',
              isActive: true,
              _count: { products: 2 },
            },
          ]),
        },
        order: { findMany: findOrders, groupBy: groupOrders },
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      { resolveImageUrl: (value: string) => Promise.resolve(value) } as never,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('exports the full matching journal while ignoring visible-page pagination', async () => {
    const query = Object.assign(new QueryMovementsDto(), {
      page: 2,
      limit: 1,
      period: AnalyticsPeriod.MONTHLY,
    });
    const result = await service.stockMovementsExport(query);
    expect(result.items).toHaveLength(25);
    expect(findMovements.mock.calls[0][0]).not.toHaveProperty('take');
    expect(findMovements.mock.calls[0][0]).not.toHaveProperty('skip');
    expect(result.from.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(result.to.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });

  it('retains type and product filters in the movement export', async () => {
    const query = Object.assign(new QueryMovementsDto(), {
      type: StockMovementType.INBOUND,
      productId,
    });
    const result = await service.stockMovementsExport(query);
    expect(result.items).toHaveLength(13);
    expect(result.items.every((row) => row.type === StockMovementType.INBOUND)).toBe(true);
    expect(findMovements.mock.calls[0][0].where?.productId).toBe(productId);
    expect(result.movementType).toBe(StockMovementType.INBOUND);
  });

  it('includes low stock and fulfilment beyond the preview limits', async () => {
    const result = await service.stockReportExport(new QueryMovementsDto());
    expect(result.movements).toHaveLength(25);
    expect(result.lowStock).toHaveLength(30);
    expect(result.fulfillment.orders).toHaveLength(25);
    expect((await service.lowStock()).length).toBe(20);
    expect((await service.fulfillmentQueue()).orders.length).toBe(20);
    expect(result.summary.from).toEqual(result.from);
    expect(result.summary.to).toEqual(result.to);
  });

  it('filters every report section to one tile and uses current stock instead of period movements', async () => {
    const result = await service.stockReportExport(
      Object.assign(new QueryMovementsDto(), { productId, type: StockMovementType.INBOUND }),
    );
    expect(result.tile?.id).toBe(productId);
    expect(result.valuation).toHaveLength(1);
    expect(result.valuation[0]).toMatchObject({
      quantityOnHandSqm: 5,
      averageCostPrice: 4,
      inventoryValue: 20,
    });
    expect(result.summary.totalInventoryValue).toBe(20);
    expect(result.summary.activeProducts).toBe(1);
    expect(result.summary.netChange).toBe(15);
    expect(result.movements).toHaveLength(13);
    expect(result.lowStock.map((row) => row.productId)).toEqual([productId]);
    expect(result.fulfillment.orders).toHaveLength(13);
    expect(result.fulfillment.byStatus.find((row) => row.status === 'PENDING')?.count).toBe(13);
    expect(
      result.fulfillment.orders.every(
        (row) => row.items.length === 1 && row.items[0].totalPieces === 3,
      ),
    ).toBe(true);
    const orderQuery = (
      findOrders.mock.calls as [
        {
          where: { items: unknown };
          include: { items: unknown };
        },
      ][]
    )[0][0];
    expect(orderQuery.where.items).toEqual({ some: { productId } });
    expect(orderQuery.include.items).toEqual({
      where: { productId },
      select: { totalPieces: true },
    });
  });

  it('includes current valuation even for an inactive tile with no movements and zero stock', async () => {
    findProducts.mockResolvedValue([
      {
        id: productId,
        name: 'Inactive tile',
        sku: 'OLD',
        isActive: false,
        quantityOnHandSqm: 0,
        averageCostPrice: 12,
        collection: { size: '30×30cm' },
      },
    ]);
    findMovements.mockResolvedValue([]);
    const result = await service.stockMovementsExport(
      Object.assign(new QueryMovementsDto(), { productId }),
    );
    expect(result.items).toEqual([]);
    expect(result.tile?.isActive).toBe(false);
    expect(result.valuation[0]).toMatchObject({
      quantityOnHandSqm: 0,
      inventoryValue: 0,
      averageCostPrice: 12,
    });
  });

  it('rejects a nonexistent tile rather than exporting unfiltered data', async () => {
    await expect(
      service.stockReportExport(Object.assign(new QueryMovementsDto(), { productId: 'missing' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findOrders).not.toHaveBeenCalled();
    expect(findMovements).not.toHaveBeenCalled();
  });

  it('lists tile choices without a stock or active-catalog filter', async () => {
    const result = await service.stockExportTiles();
    expect(result).toHaveLength(30);
    expect(result[0]).toMatchObject({ id: productId, size: '30×30cm' });
    const [choicesQuery] = (findProducts.mock.calls as [Record<string, unknown>][])[0];
    expect(choicesQuery).not.toHaveProperty('where');
  });

  it('applies custom dates and tile/type filters together while retaining current valuation', async () => {
    const result = await service.stockReportExport(
      Object.assign(new QueryStockExportDto(), {
        productId,
        type: StockMovementType.OUTBOUND,
        startDate: '2026-10-05',
        endDate: '2026-10-05',
      }),
    );
    expect(result.from.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(result.to.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(result.movements).toHaveLength(12);
    expect(result.summary.trend).toEqual([{ label: 'Oct 05', value: 15 }]);
    expect(result.valuation[0].inventoryValue).toBe(20);
    expect(
      findMovements.mock.calls.every(
        ([read]) =>
          read.where?.createdAt?.gte.toISOString() === '2026-10-05T00:00:00.000Z' &&
          read.where?.createdAt?.lt.toISOString() === '2026-10-06T00:00:00.000Z',
      ),
    ).toBe(true);
  });

  it('exports a collection across movements, summaries, low stock and only matching fulfilment lines', async () => {
    const result = await service.stockReportExport(
      Object.assign(new QueryStockExportDto(), {
        collectionId,
        startDate: '2026-10-05',
        endDate: '2026-10-05',
      }),
    );
    expect(result.tile).toBeNull();
    expect(result.collection).toMatchObject({ id: collectionId, title: 'Floor Tiles' });
    expect(result.valuation.map((row) => row.productId)).toEqual([productId, 'tile-1']);
    expect(result.summary.totalInventoryValue).toBe(40);
    expect(result.summary.activeProducts).toBe(2);
    expect(result.lowStock.map((row) => row.productId)).toEqual([productId, 'tile-1']);
    expect(result.movements).toHaveLength(25);
    expect(result.fulfillment.orders).toHaveLength(14);
    expect(
      result.fulfillment.orders.every((row) => row.items.every((item) => item.totalPieces !== 99)),
    ).toBe(true);
    expect(result.fulfillment.byStatus.find((row) => row.status === 'PENDING')?.count).toBe(14);
    expect(
      findMovements.mock.calls.every(
        ([read]) => read.where?.product?.collectionId === collectionId,
      ),
    ).toBe(true);
  });

  it('supports an empty collection with an empty journal and zero current valuation', async () => {
    findCollection.mockResolvedValue({
      id: collectionId,
      title: 'Empty',
      size: '30×30cm',
      isActive: false,
      _count: { products: 0 },
    });
    findProducts.mockResolvedValue([]);
    findMovements.mockResolvedValue([]);
    const result = await service.stockMovementsExport(
      Object.assign(new QueryStockExportDto(), { collectionId }),
    );
    expect(result.collection?.title).toBe('Empty');
    expect(result.valuation).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it('rejects nonexistent collections and conflicting tile/collection scopes before reading stock', async () => {
    await expect(
      service.stockReportExport(
        Object.assign(new QueryStockExportDto(), { productId, collectionId }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    findCollection.mockResolvedValue(null);
    await expect(
      service.stockMovementsExport(Object.assign(new QueryStockExportDto(), { collectionId })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findProducts).not.toHaveBeenCalled();
    expect(findMovements).not.toHaveBeenCalled();
  });

  it('does not return a partial report if one of the report reads fails', async () => {
    findOrders.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(service.stockReportExport(new QueryMovementsDto())).rejects.toThrow(
      'Queue unavailable',
    );
  });
});

describe('stock print/export role access', () => {
  const allowed = (handler: keyof ReportsController, role: Role) => {
    const context = {
      getHandler: () =>
        (ReportsController.prototype as unknown as Record<string, () => void>)[handler],
      getClass: () => ReportsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
  };
  it.each([
    'stockReportExport',
    'stockMovementsExport',
    'stockExportTiles',
    'stockExportCollections',
  ] as const)('%s uses the report-reader role guard', (handler) => {
    for (const role of [Role.ADMIN, Role.STOCK_MANAGER, Role.DATA_ANALYST])
      expect(allowed(handler, role)).toBe(true);
    for (const role of [Role.CLIENT, Role.SALES_PERSON])
      expect(() => allowed(handler, role)).toThrow(ForbiddenException);
  });
});

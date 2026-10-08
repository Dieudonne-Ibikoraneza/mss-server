import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, StockMovementType } from '@prisma/client';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { QueryMovementsDto } from './dto/query-movements.dto';

type Query = {
  where?: { createdAt?: { gte: Date; lt: Date }; type?: StockMovementType; productId?: string };
  skip?: number;
  take?: number;
};
const productId = 'd8ddc722-9907-4d55-84c3-16c37926cd13';
const at = new Date('2026-10-05T12:00:00Z');
const movements = Array.from({ length: 25 }, (_, index) => ({
  id: `movement-${index}`,
  productId,
  createdAt: at,
  type: index % 2 ? StockMovementType.OUTBOUND : StockMovementType.INBOUND,
  changeAreaSqm: index % 2 ? -2 : 3,
  product: { id: productId, name: 'Tile', sku: 'TILE' },
  adjustedBy: { id: 'staff', fullName: 'Stock Manager' },
}));

describe('complete stock report exports', () => {
  const findMovements = jest.fn<Promise<typeof movements>, [Query]>();
  const findOrders = jest.fn();
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
        .filter((row) => !query.where?.productId || row.productId === query.where.productId);
      return Promise.resolve(
        rows.slice(
          query.skip ?? 0,
          query.take === undefined ? undefined : (query.skip ?? 0) + query.take,
        ),
      );
    });
    const orders = Array.from({ length: 25 }, (_, index) => ({ id: `order-${index}`, items: [] }));
    findOrders.mockImplementation((query: { take?: number }) =>
      Promise.resolve(orders.slice(0, query.take)),
    );
    service = new ReportsService(
      {
        stockAdjustment: { findMany: findMovements },
        product: {
          findMany: jest.fn().mockResolvedValue(
            Array.from({ length: 30 }, (_, index) => ({
              id: `tile-${index}`,
              name: 'Tile',
              sku: `TILE-${index}`,
              image: 'tile.webp',
              quantityOnHandSqm: 5,
              averageCostPrice: 4,
              price: 10,
              updatedAt: at,
              collection: { size: '30×30cm' },
            })),
          ),
        },
        order: { findMany: findOrders, groupBy: jest.fn().mockResolvedValue([]) },
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
  it.each(['stockReportExport', 'stockMovementsExport'] as const)(
    '%s uses the report-reader role guard',
    (handler) => {
      for (const role of [Role.ADMIN, Role.STOCK_MANAGER, Role.DATA_ANALYST])
        expect(allowed(handler, role)).toBe(true);
      for (const role of [Role.CLIENT, Role.SALES_PERSON])
        expect(() => allowed(handler, role)).toThrow(ForbiddenException);
    },
  );
});

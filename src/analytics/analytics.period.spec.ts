import { JourneyStage, OrderStatus, QuotationStatus, RoomType } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { AnalyticsPeriod, resolvePeriod } from '@/common/utils/analytics-period';

type DateRange = { gte?: Date; lt?: Date; not?: null };
const inRange = (date: Date | null, range?: DateRange) =>
  !range || (date !== null && (!range.gte || date >= range.gte) && (!range.lt || date < range.lt));

describe('dashboard reporting periods', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const dates = ['2024-01-01', '2026-02-01', '2026-09-15', '2026-10-01'];
  const orders = dates.map((date, index) => ({
    customerId: `customer-${index}`,
    createdAt: new Date(`${date}T12:00:00Z`),
    paymentVerifiedAt: new Date(`${date}T12:00:00Z`),
    quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
    status: OrderStatus.DELIVERED,
    subtotal: (index + 1) * 100,
    transportFee: (index + 1) * 10,
    createdByType: 'CUSTOMER',
  }));
  const events = orders.map((order, index) => ({
    createdAt: order.createdAt,
    sessionId: `session-${index}`,
    userId: order.customerId,
    stage: index === 3 ? JourneyStage.VIEWED_TILE : JourneyStage.PURCHASED,
  }));
  let service: AnalyticsService;
  let prisma: ReturnType<typeof makePrisma>;

  const makePrisma = () => ({
    order: {
      findMany: jest.fn(({ where }: { where: { paymentVerifiedAt?: DateRange } }) =>
        Promise.resolve(
          orders.filter((row) => inRange(row.paymentVerifiedAt, where.paymentVerifiedAt)),
        ),
      ),
      count: jest.fn(({ where }: { where?: { createdAt?: DateRange; status?: unknown } } = {}) =>
        Promise.resolve(
          where?.status
            ? 0
            : orders.filter((row) => inRange(row.createdAt, where?.createdAt)).length,
        ),
      ),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { subtotal: 0 } }),
    },
    user: {
      count: jest.fn().mockResolvedValue(4),
      findMany: jest.fn().mockResolvedValue(
        orders.map((row) => ({
          id: row.customerId,
          createdAt: row.createdAt,
          status: 'ACTIVE',
        })),
      ),
      groupBy: jest.fn(({ where }: { where: { createdAt?: DateRange } }) =>
        Promise.resolve([
          {
            heardAboutUs: null,
            _count: {
              _all: orders.filter((row) => inRange(row.createdAt, where.createdAt)).length,
            },
          },
        ]),
      ),
    },
    recommendation: {
      findMany: jest.fn(({ where }: { where?: { createdAt?: DateRange } } = {}) =>
        Promise.resolve(
          orders
            .filter((row) => inRange(row.createdAt, where?.createdAt))
            .map(() => ({
              decision: 'ACCEPTED',
              purchased: true,
              matchScore: 80,
            })),
        ),
      ),
    },
    customerJourneyEvent: {
      findMany: jest.fn(({ where }: { where?: { createdAt?: DateRange } } = {}) =>
        Promise.resolve(events.filter((row) => inRange(row.createdAt, where?.createdAt))),
      ),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    orderItem: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = makePrisma();
    service = new AnalyticsService(prisma as never, {} as never);
  });

  afterEach(() => jest.useRealTimers());

  it.each([
    [AnalyticsPeriod.WEEKLY, 400, 1],
    [AnalyticsPeriod.MONTHLY, 700, 2],
    [AnalyticsPeriod.YEARLY, 900, 3],
  ])('overview and sales agree on %s totals and chart values', async (period, revenue, count) => {
    const overview = await service.overview(period);
    const sales = await service.sales(period);
    expect(overview.totalSales).toBe(revenue);
    expect(overview.totalSales).toBe(sales.totalSales);
    expect(overview.totalOrders).toBe(count);
    expect(overview.totalOrders).toBe(sales.totalOrders);
    expect(overview.totalTransportFees).toBe(revenue / 10);
    expect(overview.averageOrderValue).toBe(revenue / count);
    expect(overview.totalRecommendations).toBe(count);
    expect(overview.revenueTrend.reduce((sum, row) => sum + row.value, 0)).toBe(revenue);
    expect(overview.byCreator.reduce((sum, row) => sum + row.total, 0)).toBe(revenue);
  });

  it.each([
    [AnalyticsPeriod.WEEKLY, 1, 0],
    [AnalyticsPeriod.MONTHLY, 2, 1],
    [AnalyticsPeriod.YEARLY, 3, 2],
  ])('journey funnel and overview use only %s events', async (period, visitors, buyers) => {
    const journey = await service.journeyAnalytics(period);
    const overview = await service.overview(period);
    expect(journey.totalSessions).toBe(visitors);
    expect(journey.stages[0].customers).toBe(visitors);
    expect(journey.stages.at(-1)?.customers).toBe(buyers);
    expect(journey.overallConversionRate).toBe((buyers / visitors) * 100);
    expect(overview.funnel.map((row) => row.customers)).toEqual(
      journey.stages.map((row) => row.customers),
    );
    expect(journey.trend.reduce((sum, row) => sum + row.value, 0)).toBe(visitors);
  });

  it('acquisition channels count signups in the chosen period', async () => {
    const weekly = await service.customers(AnalyticsPeriod.WEEKLY);
    const yearly = await service.customers(AnalyticsPeriod.YEARLY);
    expect(weekly.byHeardAboutUs.reduce((sum, row) => sum + row.count, 0)).toBe(
      weekly.newCustomers,
    );
    expect(yearly.byHeardAboutUs.reduce((sum, row) => sum + row.count, 0)).toBe(
      yearly.newCustomers,
    );
    expect(weekly.newCustomers).toBe(1);
    expect(yearly.newCustomers).toBe(3);
    expect(prisma.order.groupBy.mock.calls[0]).toMatchObject([
      { where: { quotationStatus: QuotationStatus.PAYMENT_VERIFIED } },
    ]);
  });

  it('project revenue is dated by payment, including orders placed before the period', async () => {
    const recent = orders[3];
    prisma.orderItem.findMany.mockResolvedValue([
      {
        product: { roomTypes: [RoomType.KITCHEN] },
        totalPrice: 50,
        order: { ...recent, createdAt: orders[0].createdAt },
      },
      {
        product: { roomTypes: [RoomType.BEDROOM] },
        totalPrice: 100,
        order: { ...recent, paymentVerifiedAt: orders[0].paymentVerifiedAt },
      },
    ]);
    const result = await service.customers(AnalyticsPeriod.WEEKLY);
    expect(result.projectTypes.find((row) => row.roomType === RoomType.KITCHEN)).toEqual({
      roomType: RoomType.KITCHEN,
      customers: 0,
      revenue: 50,
    });
    expect(result.projectTypes.find((row) => row.roomType === RoomType.BEDROOM)).toEqual({
      roomType: RoomType.BEDROOM,
      customers: 1,
      revenue: 0,
    });
    const resolved = resolvePeriod(AnalyticsPeriod.WEEKLY, now);
    expect(prisma.orderItem.findMany.mock.calls[0]).toMatchObject([
      {
        where: {
          order: {
            status: { not: OrderStatus.CANCELLED },
            OR: [
              { createdAt: { gte: resolved.from, lt: resolved.to } },
              {
                paymentVerifiedAt: { gte: resolved.from, lt: resolved.to },
              },
            ],
          },
        },
      },
    ]);
  });

  it('previous 12 months start on a calendar month boundary across a leap year', async () => {
    jest.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    await service.sales(AnalyticsPeriod.YEARLY);
    expect(prisma.order.aggregate.mock.calls[0]).toMatchObject([
      {
        where: {
          paymentVerifiedAt: {
            gte: new Date('2023-02-01T00:00:00Z'),
            lt: new Date('2024-02-01T00:00:00Z'),
          },
        },
      },
    ]);
  });
});

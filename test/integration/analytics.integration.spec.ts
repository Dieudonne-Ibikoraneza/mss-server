import { OrderStatus, Role } from '@prisma/client';
import Redis from 'ioredis';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { EventsService } from '../../src/events/events.service';
import { RedisService } from '../../src/redis/redis.service';
import { AnalyticsPeriod } from '../../src/common/utils/analytics-period';
import { createActors, createProduct, makeOrders, prisma, type Actors } from './harness';

/**
 * Do the dashboard numbers match what actually happened? A scenario with known
 * outcomes is played through the real order flow, and every figure the
 * analytics pages report is compared with the truth computed from the scenario.
 */
/**
 * Rules these tests pin (each was a measured mismatch before it was fixed):
 *  - revenue is money whose payment was verified and not cancelled afterwards —
 *    shipping or delivery has nothing to do with it;
 *  - "total orders" means orders placed, on both dashboards; "pending" means
 *    unpaid, and paid-but-unshipped orders are counted separately;
 *  - a repeat customer paid at least twice;
 *  - a cancelled order is not a purchase, in the tile counts or the funnel;
 *  - a person is one customer in the funnel, whatever browser session ids they used.
 */
describe('analytics figures match the scenario that produced them', () => {
  const redisClient = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const events = new EventsService(prisma as never, new RedisService(redisClient));
  const analytics = new AnalyticsService(
    prisma as never,
    {
      resolveImageUrl: (i: string) => Promise.resolve(i),
      getSignedUrl: (i: string) => Promise.resolve(i),
    } as never,
  );
  const orders = makeOrders({ events });

  let actors: Actors;
  const customers: { id: string; role: Role }[] = [];
  let product: Awaited<ReturnType<typeof createProduct>>;

  const asCustomer = (i: number) => ({ id: customers[i].id, role: Role.CLIENT }) as never;
  const staff = () => actors.staff;

  /** Places an order for customer `i` and takes it as far as `upTo`. */
  const flow = async (
    i: number,
    productId: string,
    areaSqm: number,
    upTo:
      'placed' | 'quoted' | 'paid' | 'processing' | 'delivered' | 'cancelledAfterPaid' | 'rejected',
  ) => {
    const customer = asCustomer(i);
    const result = await orders.create(
      {
        type: 'PURCHASE',
        items: [{ productId, areaSqm }],
        delivery: { contactName: 'A', phone: '+250788000000', address: 'KG 1', city: 'Kigali' },
      } as never,
      customer,
    );
    if (!result.orderCreated) throw new Error('unexpected negotiation');
    const id = result.order.id;
    if (upTo === 'placed') return id;
    await orders.sendQuotation(id, { transportFee: 5 }, staff());
    if (upTo === 'quoted') return id;
    await prisma.order.update({ where: { id }, data: { quotationViewedAt: new Date() } });
    await orders.markPaymentSubmitted(id, customer);
    if (upTo === 'rejected') {
      await orders.rejectPayment(id, { reason: 'wrong amount' }, staff());
      return id;
    }
    await orders.verifyPayment(id, staff());
    if (upTo === 'paid') return id;
    if (upTo === 'cancelledAfterPaid') {
      await orders.updateStatus(id, { status: OrderStatus.CANCELLED }, staff());
      return id;
    }
    await orders.updateStatus(id, { status: OrderStatus.PROCESSING }, staff());
    if (upTo === 'processing') return id;
    for (const status of [
      OrderStatus.READY_FOR_DISPATCH,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    ]) {
      await orders.updateStatus(id, { status }, staff());
    }
    return id;
  };

  beforeAll(async () => {
    // Every figure is a whole-system total, so start from an empty ledger — the other
    // suites share this schema and would otherwise add their own orders and events.
    await prisma.tileEvent.deleteMany();
    await prisma.customerJourneyEvent.deleteMany();
    await prisma.order.deleteMany();
    actors = await createActors();
    for (let n = 0; n < 3; n++) {
      const user = await prisma.user.create({
        data: {
          fullName: `IT Buyer ${n}`,
          email: `it-buyer-${Date.now().toString(36)}${n}@example.test`,
          phone: `+2507${(Date.now() % 10000000).toString().padStart(7, '0')}${n + 3}`,
          role: Role.CLIENT,
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: new Date(),
        },
      });
      customers.push({ id: user.id, role: Role.CLIENT });
    }
    product = await createProduct(actors, { onHand: 1000, price: 100 });
    const scarce = await createProduct(actors, { onHand: 10, reserved: 8, price: 50 });

    // Customer 0 browses first (the storefront records these under a per-browser session id) ...
    for (const stage of ['OPENED_SYSTEM', 'VIEWED_TILE', 'SAVED_DESIGN'] as const) {
      await events.recordJourneyEvent({
        userId: customers[0].id,
        sessionId: 'browser-session-of-customer-0',
        stage,
        role: Role.CLIENT,
      });
    }
    // ... then the orders. 400 + 100 delivered; 200 paid and being prepared; 300 quoted, unpaid;
    // 100 paid then cancelled; 200 waitlisted; 100 payment rejected (back to unpaid).
    await flow(0, product.id, 4, 'delivered');
    await flow(0, product.id, 1, 'delivered');
    await flow(0, product.id, 2, 'processing');
    await flow(1, product.id, 3, 'quoted');
    await flow(1, product.id, 1, 'cancelledAfterPaid');
    await orders.create(
      {
        type: 'PURCHASE',
        items: [{ productId: scarce.id, areaSqm: 4 }],
        delivery: { contactName: 'A', phone: '+250788000000', address: 'KG 1', city: 'Kigali' },
      } as never,
      asCustomer(2),
    );
    await flow(2, product.id, 1, 'rejected');
  });
  afterAll(async () => {
    redisClient.disconnect();
    await prisma.$disconnect();
  });

  it('sanity: the scenario is what we think it is', async () => {
    const byStatus = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
    const count = (status: OrderStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    expect({
      delivered: count(OrderStatus.DELIVERED),
      processing: count(OrderStatus.PROCESSING),
      pending: count(OrderStatus.PENDING),
      cancelled: count(OrderStatus.CANCELLED),
      waitlisted: count(OrderStatus.WAITLISTED),
    }).toEqual({ delivered: 2, processing: 1, pending: 2, cancelled: 1, waitlisted: 1 });
  });

  it('SALES: money figures', async () => {
    const overview = await analytics.overview(AnalyticsPeriod.MONTHLY);
    const sales = await analytics.sales(AnalyticsPeriod.MONTHLY);
    // truth: 700 received from paid orders that were not cancelled (400 + 100 delivered, 200 being
    // prepared) — the 100 paid-then-cancelled and the unpaid orders do not count
    expect(overview.totalSales).toBe(sales.totalSales); // the two dashboards must agree for the same period
    expect(sales.totalSales).toBe(700);
    expect(sales.paidOrders).toBe(3);
    expect(sales.unpaidOrders).toBe(2); // the sales page's "pending" card, same meaning as the overview's
    expect(sales.averageOrderValue).toBeCloseTo(700 / 3);
  });

  it('ORDERS: counts', async () => {
    const overview = await analytics.overview(AnalyticsPeriod.MONTHLY);
    const sales = await analytics.sales(AnalyticsPeriod.MONTHLY);

    // one name, one meaning: both dashboards say "total orders"
    expect(overview.totalOrders).toBe(sales.totalOrders);
    // unpaid quotations and paid orders being prepared are different piles
    expect(overview.pendingOrders).toBe(2); // truth: unpaid PENDING orders only
    expect(overview.pendingFulfillments).toBe(1); // paid, being prepared
    expect(sales.totalOrders).toBe(7);
  });

  it('CUSTOMERS: repeat purchase rate counts customers with 2+ PAID orders', async () => {
    const overview = await analytics.overview(AnalyticsPeriod.MONTHLY);
    expect(overview.repeatCustomers).toBe(1);
  });

  it('TILES: "purchased" counts only sales that stood', async () => {
    const raw = await prisma.tileEvent.count({
      where: { productId: product.id, type: 'PURCHASED' },
    });
    expect(raw).toBe(3);
  });

  it('FUNNEL: a person is one customer, and a cancelled purchase is not a purchase', async () => {
    const funnel = await analytics.conversionFunnel();
    const at = (stage: string) => funnel.find((row) => row.stage === stage)?.customers;

    // 3 real people took part; customer 0 must not be counted once per session id
    expect(at('OPENED_SYSTEM')).toBe(3);
    expect(at('PURCHASED')).toBe(1);
  });

  it('OPENED_SYSTEM is recorded once per customer for good, not once a day', async () => {
    const user = await prisma.user.create({
      data: {
        fullName: 'IT Returning Visitor',
        email: `it-returning-${Date.now().toString(36)}@example.test`,
        role: Role.CLIENT,
      },
    });
    const open = (sessionId: string) =>
      events.recordPublicJourneyEvent({
        userId: user.id,
        sessionId,
        stage: 'OPENED_SYSTEM',
        role: Role.CLIENT,
      });
    const rowsOnRecord = () =>
      prisma.customerJourneyEvent.count({ where: { userId: user.id, stage: 'OPENED_SYSTEM' } });

    await open('session-day-1');
    await open('session-day-1');
    expect(await rowsOnRecord()).toBe(1);

    // The next day: the 24h Redis window has lapsed (and is gone entirely after a
    // cache flush), on a different browser session — still not a second entry.
    await redisClient.del(`events:dedup:journey:${user.id}:OPENED_SYSTEM`);
    await open('session-day-2');
    expect(await rowsOnRecord()).toBe(1);

    // Staff never count, as before.
    expect(
      await events.recordPublicJourneyEvent({
        userId: actors.staff.id,
        sessionId: 'staff-session',
        stage: 'OPENED_SYSTEM',
        role: Role.ADMIN,
      }),
    ).toBeNull();
  });
});

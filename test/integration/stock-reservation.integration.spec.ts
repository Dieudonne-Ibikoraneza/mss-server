import { OrderStatus, QuotationStatus } from '@prisma/client';
import {
  deductOnHandAtomically,
  InsufficientStockError,
} from '../../src/orders/stock-reservation.util';
import {
  createActors,
  createProduct,
  makeOrders,
  markPaymentSubmitted,
  orderState,
  placeOrder,
  prisma,
  productState,
  sent,
  type Actors,
} from './harness';

/**
 * Stock reservation under real concurrency: several requests (and several
 * "servers") acting on the same tiles at the same moment, against real Postgres.
 */
describe('stock reservation under concurrency', () => {
  let actors: Actors;
  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  const statuses = async (orderIds: string[]) => {
    const orders = await prisma.order.findMany({ where: { id: { in: orderIds } } });
    const count = (status: OrderStatus) => orders.filter((order) => order.status === status).length;
    return {
      pending: count(OrderStatus.PENDING),
      waitlisted: count(OrderStatus.WAITLISTED),
      cancelled: count(OrderStatus.CANCELLED),
    };
  };

  it('simultaneous checkouts never reserve more than is on hand', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const service = makeOrders();
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => placeOrder(service, actors, product.id, 4)),
    );

    // 10 m² only covers two 4 m² orders; the rest are waitlisted instead of over-reserving.
    expect(await statuses(ids)).toMatchObject({ pending: 2, waitlisted: 4 });
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 8 });
  });

  it('simultaneous promotions from several servers promote each order once and reserve once', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const seed = makeOrders();
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => placeOrder(seed, actors, product.id, 4)),
    );
    // Free everything, leaving all four waitlisted or pending orders to be re-decided.
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { status: OrderStatus.WAITLISTED, reservationExpiresAt: null },
    });
    await prisma.product.update({ where: { id: product.id }, data: { reservedAreaSqm: 0 } });

    await Promise.all(
      Array.from({ length: 6 }, () => makeOrders().promoteWaitlistedOrders([product.id])),
    );

    expect(await statuses(ids)).toMatchObject({ pending: 2, waitlisted: 2 });
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 8 });
  });

  it('a waitlisted order that is edited keeps its place — the older waitlisted order gets the stock', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const service = makeOrders();
    await placeOrder(service, actors, product.id, 8); // holds 8 of 10
    const older = await placeOrder(service, actors, product.id, 4); // waitlisted first
    const younger = await placeOrder(service, actors, product.id, 4); // waitlisted second
    // Stock frees up silently (no promotion pass yet): room for exactly one 4 m² order.
    await prisma.product.update({ where: { id: product.id }, data: { reservedAreaSqm: 6 } });

    await service.updateItems(
      younger,
      { items: [{ productId: product.id, areaSqm: 4 }] },
      actors.staff,
    );

    expect((await orderState(older)).status).toBe(OrderStatus.PENDING);
    expect((await orderState(younger)).status).toBe(OrderStatus.WAITLISTED);
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 10 });
  });

  it('editing a waitlisted order never counts another order’s hold as free stock', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const service = makeOrders();
    await placeOrder(service, actors, product.id, 8);
    const waitlisted = await placeOrder(service, actors, product.id, 4);

    await service.updateItems(
      waitlisted,
      { items: [{ productId: product.id, areaSqm: 4 }] },
      actors.staff,
    );

    expect((await orderState(waitlisted)).status).toBe(OrderStatus.WAITLISTED);
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 8 });
  });

  it('overlapping expiry sweeps release each expired order once; unquoted and paid orders are left alone', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const service = makeOrders();
    const expiredAt = new Date(Date.now() - 60_000);
    const lapsedQuoted = await Promise.all(
      [1, 2].map(() => placeOrder(service, actors, product.id, 4)),
    );
    await prisma.order.updateMany({
      where: { id: { in: lapsedQuoted } },
      data: { quotationStatus: QuotationStatus.QUOTATION_SENT, reservationExpiresAt: expiredAt },
    });
    const unquoted = await placeOrder(service, actors, product.id, 4); // still awaiting its quotation
    await prisma.order.update({
      where: { id: unquoted },
      data: { reservationExpiresAt: expiredAt },
    });
    const paid = await placeOrder(service, actors, product.id, 4);
    await markPaymentSubmitted(paid);
    await prisma.order.update({ where: { id: paid }, data: { reservationExpiresAt: expiredAt } });
    sent.reservationExpired.length = 0;

    await Promise.all(
      [makeOrders(), makeOrders(), makeOrders()].map((server) =>
        server.releaseExpiredReservations(),
      ),
    );

    expect(await statuses(lapsedQuoted)).toMatchObject({ cancelled: 2 });
    expect((await orderState(unquoted)).status).toBe(OrderStatus.PENDING); // the customer could not act yet
    expect((await orderState(paid)).status).toBe(OrderStatus.PENDING); // a submitted payment is never swept
    // 4 (unquoted) + 4 (paid) still held; the two expired holds were released once, not once per server.
    expect(await productState(product.id)).toEqual({ onHand: 100, reserved: 8 });
    expect(sent.reservationExpired).toHaveLength(2);
  });

  it('two deductions can never spend the same tiles', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const results = await Promise.allSettled(
      [6, 6].map((areaSqm) =>
        prisma.$transaction((tx) =>
          deductOnHandAtomically(tx, [{ productId: product.id, areaSqm }]),
        ),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(failure?.reason).toBeInstanceOf(InsufficientStockError);
    expect((await productState(product.id)).onHand).toBe(4); // never negative
  });
});

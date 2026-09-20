import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, QuotationStatus, StockMovementType } from '@prisma/client';
import {
  createActors,
  createProduct,
  makeOrders,
  markPaymentSubmitted,
  orderState,
  outcome,
  placeOrder,
  prisma,
  productState,
  readForVerification,
  type Actors,
} from './harness';

/**
 * The reservation → quotation → payment → fulfilment lifecycle, with the races
 * that used to double-release or double-deduct stock exercised for real.
 */
describe('payment verification and the order lifecycle', () => {
  let actors: Actors;
  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  /** An order whose customer has said they paid, with its 4 m² still on hold (on hand 10). */
  async function paidOrder(onHand = 10) {
    const product = await createProduct(actors, { onHand });
    const orderId = await placeOrder(makeOrders(), actors, product.id, 4);
    await markPaymentSubmitted(orderId);
    return { product, orderId };
  }

  describe('verifying a payment', () => {
    it('several staff verifying at once: one winner, stock released and deducted exactly once', async () => {
      const { product, orderId } = await paidOrder();

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => makeOrders().verifyPayment(orderId, actors.staff)),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException);
      }
      // 4 m² leave on-hand once, and the hold is gone once — not 4 times.
      expect(await productState(product.id)).toEqual({ onHand: 6, reserved: 0 });
      const movements = await prisma.stockAdjustment.findMany({
        where: { productId: product.id, type: StockMovementType.OUTBOUND },
      });
      expect(movements).toHaveLength(1);
      expect((await orderState(orderId)).quotationStatus).toBe(QuotationStatus.PAYMENT_VERIFIED);
    });

    it('a verification that read the order before another one finished changes nothing', async () => {
      const { product, orderId } = await paidOrder();
      const staleRead = await readForVerification(orderId); // read while still PAYMENT_SUBMITTED
      await makeOrders().verifyPayment(orderId, actors.staff); // the other request wins
      const afterFirst = await productState(product.id);

      // The late request still believes the payment is waiting: it must not release or deduct again.
      const late = await outcome(() =>
        makeOrders({ staleOrder: staleRead }).verifyPayment(orderId, actors.staff),
      );

      expect(late).toBe(ConflictException.name);
      expect(await productState(product.id)).toEqual(afterFirst);
      expect(afterFirst).toEqual({ onHand: 6, reserved: 0 });
      const movements = await prisma.stockAdjustment.count({
        where: { productId: product.id, type: StockMovementType.OUTBOUND },
      });
      expect(movements).toBe(1);
    });

    it('a verification that read the order before it was cancelled cannot verify it, release its hold again or deduct stock', async () => {
      const { product, orderId } = await paidOrder();
      const staleRead = await readForVerification(orderId); // read while still open
      await makeOrders().updateStatus(orderId, { status: OrderStatus.CANCELLED }, actors.staff); // cancellation wins
      expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 0 });

      const late = await outcome(() =>
        makeOrders({ staleOrder: staleRead }).verifyPayment(orderId, actors.staff),
      );

      expect(late).toBe(ConflictException.name);
      // Not double-released (reserved would go negative), not deducted, not marked verified.
      expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 0 });
      const order = await orderState(orderId);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.quotationStatus).toBe(QuotationStatus.PAYMENT_SUBMITTED);
    });

    it('verification racing a cancellation ends in exactly one consistent state', async () => {
      for (let round = 0; round < 6; round++) {
        const { product, orderId } = await paidOrder();

        await Promise.allSettled([
          makeOrders().verifyPayment(orderId, actors.staff),
          makeOrders().updateStatus(orderId, { status: OrderStatus.CANCELLED }, actors.staff),
        ]);

        const order = await orderState(orderId);
        const stock = await productState(product.id);
        const verified = order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED;
        const cancelled = order.status === OrderStatus.CANCELLED;
        if (verified && !cancelled) {
          // Verification won: paid, deducted once, hold gone.
          expect(stock).toEqual({ onHand: 6, reserved: 0 });
        } else if (cancelled && !verified) {
          // Cancellation won: nothing deducted, hold released — and nothing verified afterwards.
          expect(stock).toEqual({ onHand: 10, reserved: 0 });
        } else if (verified && cancelled) {
          // Verified first, then cancelled: the paid stock is returned, the hold is not released twice.
          expect(stock).toEqual({ onHand: 10, reserved: 0 });
        } else {
          throw new Error(`round ${round}: neither verified nor cancelled`);
        }
        expect(stock.reserved).toBeGreaterThanOrEqual(0);
      }
    });

    it('refuses when the payment was never submitted, and when the order is cancelled', async () => {
      const product = await createProduct(actors, { onHand: 10 });
      const unpaid = await placeOrder(makeOrders(), actors, product.id, 4);
      expect(await outcome(() => makeOrders().verifyPayment(unpaid, actors.staff))).toBe(
        BadRequestException.name,
      );

      const { orderId } = await paidOrder();
      await makeOrders().updateStatus(orderId, { status: OrderStatus.CANCELLED }, actors.staff);
      expect(await outcome(() => makeOrders().verifyPayment(orderId, actors.staff))).toBe(
        BadRequestException.name,
      );
    });
  });

  describe('status changes', () => {
    it('an unpaid order cannot leave PENDING (its stock would go unprotected); a paid one can, one step at a time', async () => {
      const product = await createProduct(actors, { onHand: 10 });
      const service = makeOrders();
      const unpaid = await placeOrder(service, actors, product.id, 4);
      expect(
        await outcome(() =>
          service.updateStatus(unpaid, { status: OrderStatus.PROCESSING }, actors.staff),
        ),
      ).toBe(BadRequestException.name);
      expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 4 });

      const { orderId } = await paidOrder();
      await service.verifyPayment(orderId, actors.staff);
      expect(
        await outcome(() =>
          service.updateStatus(orderId, { status: OrderStatus.SHIPPED }, actors.staff),
        ),
      ).toBe(BadRequestException.name); // skipping ahead
      expect(
        await outcome(() =>
          service.updateStatus(orderId, { status: OrderStatus.PROCESSING }, actors.staff),
        ),
      ).toBe('ok');
      expect(
        await outcome(() =>
          service.updateStatus(orderId, { status: OrderStatus.PENDING }, actors.staff),
        ),
      ).toBe(BadRequestException.name); // going back
    });

    it('cancelling an unpaid order releases its hold once, even if clicked twice at the same moment', async () => {
      const product = await createProduct(actors, { onHand: 10 });
      const orderId = await placeOrder(makeOrders(), actors, product.id, 4);

      const results = await Promise.all(
        [1, 2, 3].map(() =>
          outcome(() =>
            makeOrders().updateStatus(orderId, { status: OrderStatus.CANCELLED }, actors.staff),
          ),
        ),
      );

      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 0 });
    });
  });

  describe('the quotation', () => {
    it('cannot go out without delivery details, or on a waitlisted order', async () => {
      const service = makeOrders();
      const product = await createProduct(actors, { onHand: 10 });
      const noDelivery = await service
        .create(
          { type: 'PURCHASE', items: [{ productId: product.id, areaSqm: 4 }] } as never,
          actors.customer,
        )
        .then((result) => (result.orderCreated ? result.order.id : ''));
      expect(
        await outcome(() => service.sendQuotation(noDelivery, { transportFee: 5 }, actors.staff)),
      ).toBe(BadRequestException.name);

      const scarce = await createProduct(actors, { onHand: 10, reserved: 8 });
      const waitlisted = await placeOrder(service, actors, scarce.id, 4);
      expect((await orderState(waitlisted)).status).toBe(OrderStatus.WAITLISTED);
      expect(
        await outcome(() => service.sendQuotation(waitlisted, { transportFee: 5 }, actors.staff)),
      ).toBe(BadRequestException.name);
    });

    it('starts the payment window when it is sent, and re-sending makes the customer view it again', async () => {
      const service = makeOrders();
      const product = await createProduct(actors, { onHand: 10 });
      const orderId = await placeOrder(service, actors, product.id, 4);
      await prisma.order.update({
        where: { id: orderId },
        data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
      }); // old clock
      const before = Date.now();

      await service.sendQuotation(orderId, { transportFee: 5 }, actors.staff);
      const sent = await orderState(orderId);
      expect(sent.reservationExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        before + 60 * 60_000 - 1000,
      );

      await prisma.order.update({
        where: { id: orderId },
        data: { quotationViewedAt: new Date() },
      });
      await service.sendQuotation(orderId, { transportFee: 500 }, actors.staff);
      expect((await orderState(orderId)).quotationViewedAt).toBeNull();
      // ...so the customer can't declare payment for a version they haven't seen.
      expect(await outcome(() => service.markPaymentSubmitted(orderId, actors.customer))).toBe(
        BadRequestException.name,
      );
    });

    it('is frozen once the customer has submitted payment: no re-send, no revision', async () => {
      const { orderId, product } = await paidOrder();
      const before = await orderState(orderId);
      const service = makeOrders();

      expect(
        await outcome(() => service.sendQuotation(orderId, { transportFee: 999 }, actors.staff)),
      ).toBe(BadRequestException.name);
      expect(
        await outcome(() =>
          service.updateItems(
            orderId,
            { items: [{ productId: product.id, areaSqm: 8 }] },
            actors.staff,
          ),
        ),
      ).toBe(BadRequestException.name);

      const after = await orderState(orderId);
      expect(after.quotationStatus).toBe(QuotationStatus.PAYMENT_SUBMITTED);
      expect(Number(after.total)).toBe(Number(before.total));
      expect(after.paymentSubmittedAt).toEqual(before.paymentSubmittedAt);
    });

    it('delivery details cannot change after the quotation was sent', async () => {
      const service = makeOrders();
      const product = await createProduct(actors, { onHand: 10 });
      const orderId = await placeOrder(service, actors, product.id, 4);
      await service.sendQuotation(orderId, { transportFee: 5 }, actors.staff);

      expect(
        await outcome(() =>
          service.saveDeliveryDetails(
            orderId,
            {
              contactName: 'X',
              phone: '+250788111111',
              address: 'Elsewhere',
              city: 'Huye',
            },
            actors.customer,
          ),
        ),
      ).toBe(BadRequestException.name);
      const delivery = await prisma.orderDelivery.findUniqueOrThrow({ where: { orderId } });
      expect(delivery.address).toBe('KG 1 Ave');
    });
  });
});

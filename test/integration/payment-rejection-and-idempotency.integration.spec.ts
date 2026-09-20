import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Language, OrderMessageAuthor, OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { paymentRejectedTemplates } from '../../prisma/email-templates/payment-rejected';
import {
  createActors,
  createProduct,
  DELIVERY,
  makeOrders,
  markPaymentSubmitted,
  orderState,
  outcome,
  placeOrder,
  prisma,
  productState,
  readForVerification,
  sent,
  type Actors,
} from './harness';

describe('rejecting a submitted payment', () => {
  let actors: Actors;
  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  async function paidOrder() {
    const product = await createProduct(actors, { onHand: 10 });
    const orderId = await placeOrder(makeOrders(), actors, product.id, 4);
    await markPaymentSubmitted(orderId);
    return { product, orderId };
  }

  it('puts the quotation back to "sent", keeps the stock held, and restarts the customer’s payment window', async () => {
    const { product, orderId } = await paidOrder();
    // The hold lapsed while staff were checking — it must not cancel the order the moment it reopens.
    await prisma.order.update({
      where: { id: orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
    });
    const before = Date.now();

    await makeOrders().rejectPayment(orderId, { reason: 'Only RWF 5,000 arrived' }, actors.staff);

    const order = await orderState(orderId);
    expect(order.quotationStatus).toBe(QuotationStatus.QUOTATION_SENT);
    expect(order.paymentSubmittedAt).toBeNull();
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.reservationExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 60 * 60_000 - 1000,
    );
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 4 }); // hold untouched, nothing deducted
  });

  it('tells the customer why — in the order thread, on the timeline, and by email', async () => {
    const { orderId } = await paidOrder();
    sent.paymentRejected.length = 0;

    await makeOrders().rejectPayment(
      orderId,
      { reason: '  Wrong amount received  ' },
      actors.staff,
    );

    const message = await prisma.orderMessage.findFirstOrThrow({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    expect(message.author).toBe(OrderMessageAuthor.STAFF);
    expect(message.body).toBe('Payment not confirmed: Wrong amount received');
    const event = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, note: { startsWith: 'Payment not confirmed' } },
    });
    expect(event.note).toBe('Payment not confirmed — Wrong amount received');
    expect(sent.paymentRejected).toHaveLength(1);
    expect(sent.paymentRejected[0]).toMatchObject({ reason: 'Wrong amount received', minutes: 60 });
  });

  it('lets the customer pay properly and declare again, and staff then verify it — stock deducted once', async () => {
    const { product, orderId } = await paidOrder();
    const service = makeOrders();
    await service.rejectPayment(orderId, { reason: 'Nothing received yet' }, actors.staff);

    await service.markPaymentSubmitted(orderId, actors.customer); // the viewed quotation is still the one they pay
    await service.verifyPayment(orderId, actors.staff);

    expect((await orderState(orderId)).quotationStatus).toBe(QuotationStatus.PAYMENT_VERIFIED);
    expect(await productState(product.id)).toEqual({ onHand: 6, reserved: 0 });
  });

  it('only applies to a submitted payment, only for stock managers and admins', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const service = makeOrders();
    const unpaid = await placeOrder(service, actors, product.id, 4);
    expect(await outcome(() => service.rejectPayment(unpaid, { reason: 'x' }, actors.staff))).toBe(
      BadRequestException.name,
    );

    const { orderId } = await paidOrder();
    for (const role of [Role.CLIENT, Role.SALES_PERSON, Role.DATA_ANALYST]) {
      const user = { id: actors.staff.id, role } as AuthenticatedUser;
      expect(await outcome(() => service.rejectPayment(orderId, { reason: 'x' }, user))).toBe(
        ForbiddenException.name,
      );
    }
    await service.updateStatus(orderId, { status: OrderStatus.CANCELLED }, actors.staff);
    expect(await outcome(() => service.rejectPayment(orderId, { reason: 'x' }, actors.staff))).toBe(
      BadRequestException.name,
    );
  });

  describe('racing with verification', () => {
    it('a rejection that read the order before it was verified changes nothing', async () => {
      const { product, orderId } = await paidOrder();
      const stale = await readForVerification(orderId);
      await makeOrders().verifyPayment(orderId, actors.staff);

      const late = await outcome(() =>
        makeOrders({ staleOrder: stale }).rejectPayment(orderId, { reason: 'late' }, actors.staff),
      );

      expect(late).toBe(ConflictException.name);
      expect((await orderState(orderId)).quotationStatus).toBe(QuotationStatus.PAYMENT_VERIFIED);
      expect(await productState(product.id)).toEqual({ onHand: 6, reserved: 0 });
    });

    it('a verification that read the order before it was rejected cannot verify it or touch stock', async () => {
      const { product, orderId } = await paidOrder();
      const stale = await readForVerification(orderId);
      await makeOrders().rejectPayment(orderId, { reason: 'wrong amount' }, actors.staff);

      const late = await outcome(() =>
        makeOrders({ staleOrder: stale }).verifyPayment(orderId, actors.staff),
      );

      expect(late).toBe(ConflictException.name);
      expect((await orderState(orderId)).quotationStatus).toBe(QuotationStatus.QUOTATION_SENT);
      expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 4 });
    });

    it('simultaneous verify and reject: exactly one wins, and the stock matches the winner', async () => {
      for (let round = 0; round < 4; round++) {
        const { product, orderId } = await paidOrder();

        await Promise.allSettled([
          makeOrders().verifyPayment(orderId, actors.staff),
          makeOrders().rejectPayment(orderId, { reason: 'race' }, actors.staff),
        ]);

        const order = await orderState(orderId);
        const stock = await productState(product.id);
        if (order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED)
          expect(stock).toEqual({ onHand: 6, reserved: 0 });
        else if (order.quotationStatus === QuotationStatus.QUOTATION_SENT)
          expect(stock).toEqual({ onHand: 10, reserved: 4 });
        else throw new Error(`round ${round}: unexpected ${order.quotationStatus}`);
      }
    });

    it('two staff rejecting at once produce one rejection: one message, one email', async () => {
      const { orderId } = await paidOrder();
      sent.paymentRejected.length = 0;

      const results = await Promise.allSettled(
        [1, 2, 3].map(() => makeOrders().rejectPayment(orderId, { reason: 'same' }, actors.staff)),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.orderMessage.count({
          where: { orderId, body: 'Payment not confirmed: same' },
        }),
      ).toBe(1);
      expect(sent.paymentRejected).toHaveLength(1);
    });
  });
});

describe('the payment-rejected email', () => {
  beforeAll(async () => {
    for (const template of paymentRejectedTemplates)
      await prisma.emailTemplate.create({ data: template });
  });
  afterAll(() => prisma.$disconnect());

  const render = async (language: Language, reason: string) => {
    const config = {
      get: (key: string) => (key === 'app.clientUrl' ? 'https://shop.example' : undefined),
    };
    const service = new NotificationsService(prisma as never, config as never);
    const captured: string[][] = [];
    (service as unknown as { sendEmail: (...args: string[]) => Promise<void> }).sendEmail = (
      ...args
    ) => {
      captured.push(args);
      return Promise.resolve();
    };
    await service.sendPaymentRejectedEmail(
      'amina@example.rw',
      'Amina Uwase',
      'ORD-1',
      'order-1',
      reason,
      60,
      language,
    );
    const [to, subject, text, html] = captured[0];
    return { to, subject, text, html };
  };

  it.each([
    [Language.EN, "couldn't confirm", 'Reason:'],
    [Language.RW, 'Ntitwashoboye kwemeza', 'Icyabiteye:'],
  ])(
    'is written in %s, with the reason, the order link and the reserved time',
    async (language, subjectPart, reasonLabel) => {
      const email = await render(language, 'Only RWF 5,000 arrived');
      expect(email.to).toBe('amina@example.rw');
      expect(email.subject).toContain(subjectPart);
      expect(email.subject).toContain('ORD-1');
      expect(email.text).toContain(`${reasonLabel} Only RWF 5,000 arrived`);
      expect(email.text).toContain('60');
      expect(email.text).toContain('https://shop.example/account/orders/order-1');
    },
  );

  it('escapes the staff-typed reason in the HTML body', async () => {
    const email = await render(Language.EN, '<b>not</b> & "half"');
    expect(email.html).toContain('&lt;b&gt;not&lt;/b&gt; &amp; &quot;half&quot;');
    expect(email.html).not.toContain('<b>not</b>');
    expect(email.text).toContain('<b>not</b> & "half"'); // plain text stays plain
  });
});

describe('checkout idempotency', () => {
  let actors: Actors;
  let other: Actors;
  beforeAll(async () => {
    actors = await createActors();
    other = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  const checkout = (
    actor: Actors,
    productId: string,
    key: string,
    areaSqm = 4,
    service = makeOrders(),
  ) =>
    service.create(
      {
        type: 'PURCHASE',
        items: [{ productId, areaSqm }],
        delivery: DELIVERY,
        idempotencyKey: key,
      } as never,
      actor.customer,
    );
  const orderIdOf = (result: Awaited<ReturnType<typeof checkout>>) =>
    result.orderCreated ? result.order.id : '';
  const newKey = () => crypto.randomUUID();

  it('a retry of a checkout whose reply was lost returns the same order — nothing is duplicated', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const key = newKey();

    const first = await checkout(actors, product.id, key);
    const retry = await checkout(actors, product.id, key); // the browser never saw the first reply

    expect(orderIdOf(retry)).toBe(orderIdOf(first));
    expect(
      await prisma.order.count({ where: { customerId: actors.customer.id, clientRequestId: key } }),
    ).toBe(1);
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 4 }); // held once, not twice
  });

  it('simultaneous retries (double-click, impatient retry) all end up with one order', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const key = newKey();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkout(actors, product.id, key)),
    );

    expect(new Set(results.map(orderIdOf)).size).toBe(1);
    expect(
      await prisma.order.count({ where: { customerId: actors.customer.id, clientRequestId: key } }),
    ).toBe(1);
    expect(await productState(product.id)).toEqual({ onHand: 100, reserved: 4 });
  });

  it('refuses a key that is reused for a different cart, instead of answering with the wrong order', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const key = newKey();
    await checkout(actors, product.id, key, 4);

    const different = await outcome(() => checkout(actors, product.id, key, 8));

    expect(different).toBe(ConflictException.name);
    expect(
      await prisma.order.count({ where: { customerId: actors.customer.id, clientRequestId: key } }),
    ).toBe(1);
  });

  it('keys are per customer: another customer using the same key gets their own order', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const key = newKey();

    const mine = await checkout(actors, product.id, key);
    const theirs = await checkout(other, product.id, key);

    expect(orderIdOf(mine)).not.toBe(orderIdOf(theirs));
  });

  it('replays a waitlisted order as waitlisted, with the shortage the customer is allowed to see', async () => {
    const product = await createProduct(actors, { onHand: 10, reserved: 8 });
    const key = newKey();
    await checkout(actors, product.id, key);

    const retry = await checkout(actors, product.id, key);

    expect(retry.orderCreated && retry.order.status).toBe(OrderStatus.WAITLISTED);
    const shortages = retry.orderCreated ? retry.order.shortages : [];
    expect(shortages).toHaveLength(1);
    expect(JSON.stringify(shortages)).not.toContain('availableAreaSqm'); // exact stock stays staff-only
  });

  it('without a key, two identical checkouts are still two orders (nothing changes for staff or older clients)', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const service = makeOrders();
    const place = () =>
      service.create(
        {
          type: 'PURCHASE',
          items: [{ productId: product.id, areaSqm: 4 }],
          delivery: DELIVERY,
        } as never,
        actors.customer,
      );

    const [a, b] = await Promise.all([place(), place()]);

    expect(orderIdOf(a)).not.toBe(orderIdOf(b));
  });
});

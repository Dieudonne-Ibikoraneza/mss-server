import { PrismaClient, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from '../../src/orders/orders.service';

const url = process.env.IT_DATABASE_URL;
if (!url || !/schema=it_/.test(url)) {
  throw new Error(
    'The integration harness only runs against the throwaway schema built by global-setup.ts.',
  );
}

export const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Emails and pushes are not what these tests are about — they are recorded, never sent. */
export const sent = {
  reservationExpired: [] as string[],
  paymentRejected: [] as { to: string; orderNumber: string; reason: string; minutes: number }[],
};

/**
 * A prisma whose `order.findUnique` answers with a snapshot taken earlier — the
 * view a request had if it read the order just before another request changed
 * it. Everything else (the claim, the transaction, stock updates) is real, so
 * this pins the exact race window instead of hoping timing hits it.
 */
const withStaleOrderRead = (snapshot: unknown) => {
  const bind = <T extends object>(target: T): T =>
    new Proxy(target, {
      get: (object, property) => {
        const value = Reflect.get(object, property) as unknown;
        return typeof value === 'function'
          ? ((value as (...args: unknown[]) => unknown).bind(object) as unknown)
          : value;
      },
    });
  const order = new Proxy(bind(prisma.order), {
    get: (object, property) =>
      property === 'findUnique'
        ? () => Promise.resolve(snapshot)
        : (Reflect.get(object, property) as unknown),
  });
  return new Proxy(bind(prisma), {
    get: (object, property) =>
      property === 'order' ? order : (Reflect.get(object, property) as unknown),
  });
};

/** A fresh service instance — several of them stand in for several server processes. */
export const makeOrders = (options: { staleOrder?: unknown } = {}) => {
  const notifications = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === 'sendOrderReservationExpiredEmail'
          ? (_email: string, _name: string, orderNumber: string) => {
              sent.reservationExpired.push(orderNumber);
              return Promise.resolve();
            }
          : name === 'sendPaymentRejectedEmail'
            ? (
                to: string,
                _name: string,
                orderNumber: string,
                _orderId: string,
                reason: string,
                minutes: number,
              ) => {
                sent.paymentRejected.push({ to, orderNumber, reason, minutes });
                return Promise.resolve();
              }
            : () => Promise.resolve(),
    },
  );
  return new OrdersService(
    (options.staleOrder === undefined ? prisma : withStaleOrderRead(options.staleOrder)) as never,
    { delByPrefix: () => Promise.resolve() } as never,
    { get: () => 60 } as never,
    { recordJourneyEvent: () => Promise.resolve() } as never,
    notifications as never,
    { emitMessage: () => undefined } as never,
    {} as never,
    {} as never,
  );
};

let counter = 0;
const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface Actors {
  customer: AuthenticatedUser;
  staff: AuthenticatedUser;
  collectionId: string;
}

/** A customer, a stock manager and a tile collection — each test file gets its own. */
export async function createActors(): Promise<Actors> {
  const tag = unique('it');
  const user = (role: Role, label: string, n: number) =>
    prisma.user.create({
      data: {
        fullName: `IT ${label}`,
        email: `${tag}-${label}@example.test`,
        phone: `+2507${(Date.now() % 100000000).toString().padStart(8, '0').slice(0, 7)}${n}`,
        role,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    });
  const customer = await user(Role.CLIENT, 'customer', 1);
  const staff = await user(Role.STOCK_MANAGER, 'staff', 2);
  const collection = await prisma.collection.create({
    data: {
      title: tag,
      slug: tag,
      image: 'x',
      size: '50×50cm',
      tileAreaSqm: 0.25,
      description: 't',
    },
  });
  return {
    customer: { id: customer.id, role: Role.CLIENT } as AuthenticatedUser,
    staff: { id: staff.id, role: Role.STOCK_MANAGER } as AuthenticatedUser,
    collectionId: collection.id,
  };
}

/** 4 tiles of 0.25 m² per box, so every whole-box area is billed exactly. */
export function createProduct(
  actors: Actors,
  options: { onHand: number; reserved?: number; price?: number; active?: boolean; name?: string },
) {
  const tag = unique('p');
  return prisma.product.create({
    data: {
      sku: tag,
      name: options.name ?? `Tile ${tag}`,
      slug: tag,
      collectionId: actors.collectionId,
      boxCoverageSqm: 1,
      piecesPerBox: 4,
      price: options.price ?? 100,
      image: 'x',
      isActive: options.active ?? true,
      quantityOnHandSqm: options.onHand,
      reservedAreaSqm: options.reserved ?? 0,
    },
  });
}

export const DELIVERY = {
  contactName: 'Amina',
  phone: '+250788000000',
  address: 'KG 1 Ave',
  city: 'Kigali',
};

/** Places a customer order through the real checkout path and returns the order id. */
export async function placeOrder(
  service: OrdersService,
  actors: Actors,
  productId: string,
  areaSqm: number,
): Promise<string> {
  const result = await service.create(
    { type: 'PURCHASE', items: [{ productId, areaSqm }], delivery: DELIVERY } as never,
    actors.customer,
  );
  if (!result.orderCreated) throw new Error('checkout unexpectedly opened a negotiation');
  return result.order.id;
}

/** Puts an order in the state where the customer has viewed the quotation and said they paid. */
export function markPaymentSubmitted(orderId: string) {
  return prisma.order.update({
    where: { id: orderId },
    data: {
      quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
      quotationSentAt: new Date(),
      quotationViewedAt: new Date(),
      paymentSubmittedAt: new Date(),
    },
  });
}

export const productState = async (productId: string) => {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return { onHand: Number(product.quantityOnHandSqm), reserved: Number(product.reservedAreaSqm) };
};

export const orderState = (orderId: string) =>
  prisma.order.findUniqueOrThrow({ where: { id: orderId } });

/** Outcome of a call as a short string, so races can be asserted on without try/catch noise. */
export const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.constructor.name : 'unknown';
  }
};

/** The order exactly as `verifyPayment` reads it, for handing to `makeOrders({ staleOrder })`. */
export const readForVerification = (orderId: string) =>
  prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } }, customer: true },
  });

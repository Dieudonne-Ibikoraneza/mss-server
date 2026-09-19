import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  OrderCreatorType,
  OrderMessageAuthor,
  OrderStatus,
  Prisma,
  QuotationStatus,
  Role,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { EventsService } from '@/events/events.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { StorageService } from '@/storage/storage.service';
import { paginate } from '@/common/dto/pagination.dto';
import { availableAreaSqmOf, canSeeExactStock } from '@/common/utils/stock-status';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { invalidateProductsCache } from '@/products/products-cache.util';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SaveDeliveryDetailsDto } from './dto/save-delivery-details.dto';
import { InsufficientStockError, reserveAreaAtomically } from './stock-reservation.util';
import { canTransitionOrderStatus, ORDER_STATUS_TRANSITIONS } from './order-status-transitions';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { CreateOrderMessageDto } from './dto/create-order-message.dto';
import { UpdateOrderItemsDto } from './dto/update-order-items.dto';
import { renderQuotationPdf } from './quotation-pdf.util';
import { NegotiationsGateway } from '@/negotiations/negotiations.gateway';
import { CartNegotiationsService } from '@/cart-negotiations/cart-negotiations.service';

const STAFF_ROLES: Role[] = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.ADMIN];

/** Only these roles cost transport and confirm money has landed (doc 3.11, stock manager + admin). */
const QUOTATION_ROLES: Role[] = [Role.STOCK_MANAGER, Role.ADMIN];

const ORDER_INCLUDE = {
  items: { include: { product: true } },
  statusEvents: { orderBy: { createdAt: 'asc' } },
  payments: true,
  customer: true,
  createdBy: { select: { id: true, fullName: true } },
  delivery: true,
} satisfies Prisma.OrderInclude;

/**
 * Order items nest their full product row (for name/image/price display) —
 * strip the same staff-only fields `ProductsService` keeps out of a client's
 * own view (doc 3.2) before an order ever reaches a non-staff viewer.
 */
function sanitizeOrder<T extends { items: readonly { product: Record<string, unknown> | null }[] }>(
  order: T,
  viewerRole: Role,
): T {
  if (canSeeExactStock(viewerRole)) return order;
  return {
    ...order,
    // Older waitlisted orders stored "(requested N sqm, M sqm available)" in
    // their timeline note — the exact available figure is staff-only.
    ...('statusEvents' in order && Array.isArray(order.statusEvents)
      ? {
          statusEvents: (order.statusEvents as { note?: string | null }[]).map((event) =>
            typeof event.note === 'string'
              ? { ...event, note: stripAvailableFigures(event.note) }
              : event,
          ),
        }
      : {}),
    items: order.items.map((item) => {
      if (!item.product) return item;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { quantityOnHandSqm, reservedAreaSqm, averageCostPrice, ...productRest } = item.product;
      return { ...item, product: productRest };
    }),
  };
}

/** Removes the ", M sqm available" part of a shortage summary — the exact available area is staff-only. */
const stripAvailableFigures = (note: string) => note.replace(/,\s*[\d.,]+\s*sqm available/gi, '');

/** A SYSTEM message's `metadata` with every shortage's `availableAreaSqm` removed. */
const withoutAvailableFigures = (metadata: Prisma.JsonValue) => {
  const shortages = (metadata as { shortages?: unknown } | null)?.shortages;
  if (!Array.isArray(shortages)) return metadata;
  return {
    ...(metadata as Prisma.JsonObject),
    shortages: shortagesForCustomer(shortages as StockShortage[]),
  };
};

export interface StockShortage {
  productId: string;
  productName: string;
  requestedAreaSqm: number;
  availableAreaSqm: number;
}

/**
 * Exact stock on hand is staff-only (doc 3.2). A shortage echoed back to a
 * customer — the `POST /orders` response, or a SYSTEM message's `metadata` —
 * keeps only the product and what they asked for, never `availableAreaSqm`
 * (how much was actually on the shelf).
 */
const shortagesForCustomer = (
  shortages: StockShortage[],
): Omit<StockShortage, 'availableAreaSqm'>[] =>
  shortages.map(({ productId, productName, requestedAreaSqm }) => ({
    productId,
    productName,
    requestedAreaSqm,
  }));

/**
 * The actual area an order line ships, once its `totalPieces` (rounded up to
 * whole pieces at checkout) is converted back to m² via the product's own
 * packaging — what actually leaves stock, not the raw `requiredAreaSqm` the
 * customer typed.
 */
const purchasedAreaOf = (item: {
  totalPieces: number;
  product: { boxCoverageSqm: Prisma.Decimal | number; piecesPerBox: number };
}) => {
  const tileAreaSqm = Number(item.product.boxCoverageSqm) / item.product.piecesPerBox;
  return item.totalPieces * tileAreaSqm;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  // Re-entrancy guards for the two cron sweeps below. Each processes its
  // orders one at a time (a DB connection per iteration, not all at once),
  // but if a single tick runs long — a stalled email send, a slow query
  // against the pooled connection — the schedule fires the next tick anyway
  // rather than waiting, and the two runs' DB work now overlaps. Repeat that
  // over several ticks and it's enough concurrent transactions to exhaust the
  // connection pool out from under a real customer's own checkout. Skipping
  // an overlapping tick (logged, picked up again next interval) costs nothing
  // — both sweeps are safety nets re-run frequently — and caps how much of
  // the pool this background work can ever hold at once.
  private releasingReservations = false;
  private promotingWaitlistSweep = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly negotiations: NegotiationsGateway,
    private readonly cartNegotiations: CartNegotiationsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * An order item nests its full product row for the UI (name/image/price),
   * but that row's `image` is the raw value from the DB — a bare private-blob
   * path like "products/<uuid>.webp" that a browser can't load on its own.
   * `ProductsService` re-signs it on every `/products` read; order responses
   * skipped that step, so the product thumbnail on an order was always
   * broken. Mirrors `ProductsService.resolveImageUrl` (kept a separate copy
   * for the same reason the collections/chatbot copies are).
   */
  private async resolveImageUrl(image: string): Promise<string> {
    const selfSignedPath = /\/storage\/v1\/object\/sign\/[^/]+\/(.+?)(?:\?|$)/.exec(image);
    if (selfSignedPath) {
      try {
        return await this.storage.getSignedUrl(decodeURIComponent(selfSignedPath[1]));
      } catch {
        return image;
      }
    }
    if (/^https?:\/\//i.test(image)) return image;
    try {
      return await this.storage.getSignedUrl(image);
    } catch {
      return image;
    }
  }

  /** `sanitizeOrder` (staff-field stripping) plus a fresh signed URL for each item's product image. */
  private async serializeOrder<
    T extends {
      items: readonly { product: (Record<string, unknown> & { image?: unknown }) | null }[];
    },
  >(order: T, viewerRole: Role): Promise<T> {
    const sanitized = sanitizeOrder(order, viewerRole);
    const items = await Promise.all(
      sanitized.items.map(async (item) => {
        if (!item.product || typeof item.product.image !== 'string') return item;
        return {
          ...item,
          product: { ...item.product, image: await this.resolveImageUrl(item.product.image) },
        };
      }),
    );
    return { ...sanitized, items };
  }

  private generateOrderNumber() {
    return `ORD-${Date.now().toString(36).toUpperCase()}`;
  }

  private isStaff(role: Role) {
    return STAFF_ROLES.includes(role) || role === Role.DATA_ANALYST;
  }

  /** Loads an order and enforces "your own order, or you're staff". */
  /**
   * The data analyst can read orders (`isStaff`) but never change one — no
   * placing, no delivery details, no payment declarations. The controller
   * routes already exclude the role; this keeps the service safe on its own.
   */
  private assertCanWriteOrders(actingUser: AuthenticatedUser) {
    if (actingUser.role === Role.DATA_ANALYST) {
      throw new ForbiddenException('The data analyst role is read-only.');
    }
  }

  private async assertAccess(orderId: string, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found.');
    if (!this.isStaff(actingUser.role) && order.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this order.');
    }
    return order;
  }

  /** Runs a side effect that must never fail the request it belongs to; logs instead. */
  private async bestEffort(what: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Non-critical step failed after commit — ${what}: ${message}`);
    }
  }

  /** How long a fresh order holds its stock — `ORDER_RESERVATION_MINUTES`, default 60. */
  private reservationWindowMs(): number {
    const minutes = this.config.get<number>('orders.reservationMinutes') ?? 60;
    return minutes * 60_000;
  }

  /**
   * Applies every product's delta to one numeric column in a single
   * statement instead of one round trip per line item. This database is
   * reached over the network, not localhost (see `DATABASE_URL`) — a
   * multi-item order otherwise pays its full round-trip latency once per
   * line, on every place/cancel/promote/deliver/revise, which is most of
   * why those endpoints feel slow. Positive deltas add, negative subtract;
   * multiple entries for the same product are folded into one net change
   * before the statement is built. `column` is a compile-time-checked
   * literal, never caller-supplied data, so interpolating it directly is safe.
   */
  private async bulkAdjustProductArea(
    tx: Prisma.TransactionClient,
    column: 'reservedAreaSqm' | 'quantityOnHandSqm',
    adjustments: { productId: string; deltaAreaSqm: number }[],
  ): Promise<void> {
    const netByProduct = new Map<string, number>();
    for (const { productId, deltaAreaSqm } of adjustments) {
      if (deltaAreaSqm === 0) continue;
      netByProduct.set(productId, (netByProduct.get(productId) ?? 0) + deltaAreaSqm);
    }
    const entries = [...netByProduct.entries()];
    if (entries.length === 0) return;

    const columnRef = Prisma.raw(`"${column}"`);
    const caseBranches = Prisma.join(
      entries.map(([productId, delta]) => Prisma.sql`WHEN ${productId} THEN ${delta}::numeric`),
      ' ',
    );
    const ids = Prisma.join(entries.map(([productId]) => productId));

    await tx.$executeRaw(Prisma.sql`
      UPDATE "Product"
      SET ${columnRef} = ${columnRef} + (CASE "id" ${caseBranches} ELSE 0::numeric END)
      WHERE "id" IN (${ids})
    `);
  }

  /**
   * Only the product side of a release — decrementing each item's hold back
   * off `reservedAreaSqm`. Callers clear the order's own `reservationExpiresAt`
   * themselves, folded into whatever `order.update` they're already doing
   * (status change, quotation update, ...) so the object they return to the
   * caller reflects the release immediately, instead of the write here
   * landing a moment after the one whose result they hand back.
   */
  private async releaseReservedStock(
    tx: Prisma.TransactionClient,
    items: {
      productId: string;
      totalPieces: number;
      product: { boxCoverageSqm: Prisma.Decimal | number; piecesPerBox: number };
    }[],
  ) {
    await this.bulkAdjustProductArea(
      tx,
      'reservedAreaSqm',
      items.map((item) => ({ productId: item.productId, deltaAreaSqm: -purchasedAreaOf(item) })),
    );
  }

  /**
   * Physically removes an order's items from `quantityOnHandSqm` — the stock
   * is now the customer's, not ours. Runs once per order, at whichever comes
   * first of payment verification (`verifyPayment`) or delivery
   * (`updateStatus`), gated by `Order.stockDeductedAt` so it never fires
   * twice. Also lays down the OUTBOUND movement rows the stock report reads,
   * and the customer's PURCHASED tile/journey events (a verified payment is
   * the purchase, whether or not it's been delivered yet).
   */
  private async deductOrderStock(
    tx: Prisma.TransactionClient,
    order: {
      customerId: string;
      orderNumber: string;
      items: {
        productId: string;
        totalPieces: number;
        product: { boxCoverageSqm: Prisma.Decimal | number; piecesPerBox: number };
      }[];
    },
    actingUserId: string,
    reason: string,
  ) {
    await this.bulkAdjustProductArea(
      tx,
      'quantityOnHandSqm',
      order.items.map((item) => ({
        productId: item.productId,
        deltaAreaSqm: -purchasedAreaOf(item),
      })),
    );
    await tx.stockAdjustment.createMany({
      data: order.items.map((item) => ({
        productId: item.productId,
        changeAreaSqm: -purchasedAreaOf(item),
        type: StockMovementType.OUTBOUND,
        reference: order.orderNumber,
        reason,
        adjustedById: actingUserId,
      })),
    });
    await tx.tileEvent.createMany({
      data: order.items.map((item) => ({
        userId: order.customerId,
        sessionId: order.customerId,
        productId: item.productId,
        type: 'PURCHASED' as const,
      })),
    });
    await tx.customerJourneyEvent.create({
      data: { userId: order.customerId, sessionId: order.customerId, stage: 'PURCHASED' },
    });
  }

  /**
   * The inverse of `deductOrderStock` — returns a cancelled order's items to
   * `quantityOnHandSqm` when they had already been taken out (i.e.
   * `stockDeductedAt` was set). An INBOUND movement row records the return.
   */
  private async returnOrderStock(
    tx: Prisma.TransactionClient,
    order: {
      orderNumber: string;
      items: {
        productId: string;
        totalPieces: number;
        product: { boxCoverageSqm: Prisma.Decimal | number; piecesPerBox: number };
      }[];
    },
    actingUserId: string,
    reason: string,
  ) {
    await this.bulkAdjustProductArea(
      tx,
      'quantityOnHandSqm',
      order.items.map((item) => ({
        productId: item.productId,
        deltaAreaSqm: purchasedAreaOf(item),
      })),
    );
    await tx.stockAdjustment.createMany({
      data: order.items.map((item) => ({
        productId: item.productId,
        changeAreaSqm: purchasedAreaOf(item),
        type: StockMovementType.INBOUND,
        reference: order.orderNumber,
        reason,
        adjustedById: actingUserId,
      })),
    });
  }

  /**
   * The other half of stock reservations (doc-driven feature, no doc section
   * number yet): a PENDING order whose payment window has lapsed gets
   * auto-cancelled and its stock released, one order per transaction so a
   * single bad row can't block the rest of the sweep. Runs every minute —
   * cheap (an indexed `reservationExpiresAt` lookup) and keeps the customer's
   * wait after the window lapses short.
   *
   * The payment window only runs while the customer can actually act on it,
   * so only `QUOTATION_SENT` orders are swept: `AWAITING_REVIEW` means staff
   * haven't quoted yet (the clock restarts in `sendQuotation`), and
   * `PAYMENT_SUBMITTED` / `PAYMENT_VERIFIED` mean the customer already paid —
   * cancelling then would strand a real payment.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async releaseExpiredReservations(): Promise<void> {
    if (this.releasingReservations) {
      this.logger.warn('Skipping this reservation sweep — the previous one is still running.');
      return;
    }
    this.releasingReservations = true;
    try {
      const expired = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.PENDING,
          quotationStatus: QuotationStatus.QUOTATION_SENT,
          reservationExpiresAt: { lte: new Date() },
        },
        include: { items: { include: { product: true } }, customer: true },
      });
      if (expired.length === 0) return;

      for (const order of expired) {
        try {
          const cancelled = await this.prisma.$transaction(async (tx) => {
            // Claim the order with the same conditions the sweep selected it
            // on — the customer may have submitted payment (or staff advanced
            // the order) since the list above was read, and that must win.
            const claimed = await tx.order.updateMany({
              where: {
                id: order.id,
                status: OrderStatus.PENDING,
                quotationStatus: QuotationStatus.QUOTATION_SENT,
                reservationExpiresAt: { lte: new Date() },
              },
              data: { status: OrderStatus.CANCELLED, reservationExpiresAt: null },
            });
            if (claimed.count === 0) return false;

            await this.releaseReservedStock(tx, order.items);
            await tx.orderStatusEvent.create({
              data: {
                orderId: order.id,
                status: OrderStatus.CANCELLED,
                note: 'Automatically cancelled — the payment window expired before this order advanced, so its stock hold was released.',
              },
            });
            return true;
          });
          if (!cancelled) continue;

          await invalidateProductsCache(
            this.redis,
            order.items.map((item) => item.productId),
          );
          if (order.customer.email) {
            await this.notifications.sendOrderReservationExpiredEmail(
              order.customer.email,
              order.customer.fullName,
              order.orderNumber,
              order.customer.language,
            );
          }
          await this.promoteWaitlistedOrders(order.items.map((item) => item.productId));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          this.logger.error(
            `Failed to release expired reservation for order ${order.id}: ${message}`,
          );
        }
      }
    } finally {
      this.releasingReservations = false;
    }
  }

  /**
   * The waitlist side of stock reservations: a WAITLISTED order (doc-driven
   * feature, no doc section number yet — `create` above explains the booking
   * behaviour) that can now be fully covered gets promoted to PENDING, which
   * is what actually starts its stock hold and payment window, and its
   * customer is emailed to come pay. Called whenever stock frees up for
   * specific products — a restock (`ProductsService#adjustStock`), or another
   * order's reservation being released or expiring (above, and
   * `updateStatus`/`verifyPayment`) — and, with no `productIds`, as a
   * periodic safety net for every product.
   *
   * Oldest waitlisted order first, so an earlier customer always claims
   * freed stock before a later one; each order's check-then-reserve happens
   * inside its own transaction, one order per transaction, for the same
   * reasons `releaseExpiredReservations` does it that way.
   */
  async promoteWaitlistedOrders(productIds?: string[]): Promise<void> {
    const waitlisted = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.WAITLISTED,
        ...(productIds ? { items: { some: { productId: { in: productIds } } } } : {}),
      },
      include: { items: { include: { product: true } }, customer: true },
      orderBy: { createdAt: 'asc' },
    });
    if (waitlisted.length === 0) return;

    for (const order of waitlisted) {
      try {
        const promoted = await this.prisma.$transaction(async (tx) => {
          // Claim the order first: a second worker (another server, an
          // overlapping sweep) or a cancellation that got here first leaves
          // nothing to claim, so stock is never reserved twice for one order
          // or for one that is no longer waitlisted.
          const reservationMinutes = Math.round(this.reservationWindowMs() / 60_000);
          const claimed = await tx.order.updateMany({
            where: { id: order.id, status: OrderStatus.WAITLISTED },
            data: {
              status: OrderStatus.PENDING,
              reservationExpiresAt: new Date(Date.now() + this.reservationWindowMs()),
              waitlistPromotedAt: new Date(),
            },
          });
          if (claimed.count === 0) return false;

          // Reserves only where the stock is still there, checked inside the
          // UPDATE itself — a read-then-add here would let two promotions
          // (or a promotion and a checkout) take the same tiles. Throws, and
          // so rolls the claim back, if any product has come up short.
          await reserveAreaAtomically(
            tx,
            order.items.map((item) => ({
              productId: item.productId,
              deltaAreaSqm: purchasedAreaOf(item),
            })),
          );

          await tx.orderStatusEvent.create({
            data: {
              orderId: order.id,
              status: OrderStatus.PENDING,
              note:
                'Enough stock is now available — promoted off the waitlist and held for you. ' +
                `Once the quotation is sent you will have ${reservationMinutes} minutes to complete payment.`,
            },
          });
          return true;
        });

        if (!promoted) continue;

        await invalidateProductsCache(
          this.redis,
          order.items.map((item) => item.productId),
        );
        if (order.customer.email) {
          await this.notifications.sendOrderWaitlistAvailableEmail(
            order.customer.email,
            order.customer.fullName,
            order.orderNumber,
            order.id,
            order.customer.language,
          );
        }
      } catch (error) {
        // Not enough stock for this order right now — it stays waitlisted.
        if (error instanceof InsufficientStockError) continue;
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.error(`Failed to promote waitlisted order ${order.id}: ${message}`);
      }
    }
  }

  /** Safety net in case an event-triggered promotion was ever missed — the real work happens above, event-driven. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  private async promoteWaitlistedOrdersSweep(): Promise<void> {
    if (this.promotingWaitlistSweep) {
      this.logger.warn('Skipping this waitlist sweep — the previous one is still running.');
      return;
    }
    this.promotingWaitlistSweep = true;
    try {
      await this.promoteWaitlistedOrders();
    } finally {
      this.promotingWaitlistSweep = false;
    }
  }

  async create(
    dto: CreateOrderDto,
    actingUser: AuthenticatedUser,
    attempt = 1,
  ): Promise<Awaited<ReturnType<OrdersService['createOnce']>>> {
    this.assertCanWriteOrders(actingUser);
    try {
      return await this.createOnce(dto, actingUser);
    } catch (error) {
      // Someone else took the stock between this order's availability read and
      // its reservation. Re-run from the read so it is judged on the new numbers
      // (waitlisted, or negotiated) instead of failing the customer's checkout.
      if (error instanceof InsufficientStockError && attempt < 3) {
        return this.create(dto, actingUser, attempt + 1);
      }
      if (error instanceof InsufficientStockError) {
        throw new ConflictException('Stock changed while placing this order. Please try again.');
      }
      throw error;
    }
  }

  private async createOnce(dto: CreateOrderDto, actingUser: AuthenticatedUser) {
    const isStaff = STAFF_ROLES.includes(actingUser.role);
    if (dto.customerId && !isStaff) {
      throw new ForbiddenException('Only staff can place an order on behalf of another customer.');
    }
    const customerId = dto.customerId ?? actingUser.id;

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((item) => item.productId) } },
      include: { collection: true },
    });
    if (products.length !== dto.items.length) {
      throw new BadRequestException('One or more products could not be found.');
    }

    const lineItems = dto.items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;
      const quantity = calculateTileQuantity(item.areaSqm, {
        tileAreaSqm: Number(product.collection.tileAreaSqm),
        boxCoverageSqm: Number(product.boxCoverageSqm),
        piecesPerBox: product.piecesPerBox,
      });
      // Priced by area, not by the box: `unitPrice` is per m², and the total
      // is billed on `purchasedArea` — the actual area shipped once rounded
      // up to whole pieces, not the raw requested `areaSqm`.
      const unitPrice = Number(product.price);
      const totalPrice = quantity.purchasedArea * unitPrice;
      return { product, quantity, unitPrice, totalPrice };
    });

    /**
     * `quantityOnHandSqm` only moves when the order is actually delivered
     * (see `updateStatus` below) — but `reservedAreaSqm` (other customers'
     * still-open payment windows) is subtracted from it here, so this
     * already accounts for stock currently on hold, not just on the shelf.
     * Still a point-in-time read ahead of the transaction below — the
     * reservation inside it is what's atomic (`reserveAreaAtomically`), and
     * `create` re-runs this whole read if it loses that race.
     *
     * Two different kinds of shortage, and only one of them is waitlist-able:
     * - `available` (on hand minus what other customers' open orders are
     *   already holding) covers it → no shortage at all, order goes straight
     *   to PENDING below.
     * - `available` doesn't cover it, but `quantityOnHandSqm` (the physical
     *   total, ignoring anyone else's hold) does → temporary: another
     *   customer's reservation freeing up (expiry, cancellation, or their
     *   order being fulfilled) can cover this order later, so it's
     *   waitlist-eligible (`shortages`).
     * - not even `quantityOnHandSqm` covers it → no reservation release ever
     *   fixes this, only a restock does. Nothing to wait on, so it isn't
     *   waitlisted — see `impossibleShortages` below.
     */
    const shortages: StockShortage[] = [];
    const impossibleShortages: StockShortage[] = [];
    for (const line of lineItems) {
      const onHandAreaSqm = Number(line.product.quantityOnHandSqm);
      const availableAreaSqm = availableAreaSqmOf(
        onHandAreaSqm,
        Number(line.product.reservedAreaSqm),
      );
      if (line.quantity.purchasedArea > availableAreaSqm) {
        const shortage: StockShortage = {
          productId: line.product.id,
          productName: line.product.name,
          requestedAreaSqm: line.quantity.purchasedArea,
          availableAreaSqm,
        };
        if (line.quantity.purchasedArea > onHandAreaSqm) {
          impossibleShortages.push(shortage);
        } else {
          shortages.push(shortage);
        }
      }
    }

    /**
     * A customer's own checkout that demands more of a product than exists
     * on hand at all (not just more than is currently unreserved) can never
     * be created as an order — waiting doesn't help here, only a restock
     * does. Instead of an order, this opens/continues the customer's cart
     * negotiation thread with the stock team (same thread the cart page's
     * own pre-checkout shortage chat uses) and hands that back so the
     * caller can route them straight into it.
     *
     * Staff placing an order *on a customer's behalf* (`dto.customerId`) are
     * exempt — see the PENDING-with-shortage-message branch below, which
     * still applies to them regardless of `impossibleShortages`.
     */
    if (!isStaff && impossibleShortages.length > 0) {
      const allShortages = [...impossibleShortages, ...shortages];
      const negotiation = await this.cartNegotiations.submit(
        {
          items: allShortages.map((shortage) => ({
            productId: shortage.productId,
            productName: shortage.productName,
            requestedAreaSqm: shortage.requestedAreaSqm,
            availabilityNote: `Only ${shortage.availableAreaSqm} m² on hand right now.`,
          })),
          body:
            `I tried to place an order for ${allShortages.map((s) => s.productName).join(', ')}, ` +
            "but it's more than you have in stock. Can you help?",
        },
        actingUser,
      );
      return { orderCreated: false as const, negotiation };
    }

    // Reachable only when staff are placing on a customer's behalf (the only
    // way to get here with impossibleShortages non-empty) — fold it into the
    // same shortage list so the message/summary/metadata below still surface
    // it, and it's still reserved "regardless" alongside every other shortage.
    shortages.push(...impossibleShortages);

    /**
     * A customer checking out their own cart when part of it exceeds what's
     * currently available (but not what's on hand in total) still gets a
     * real order — accepted as a booking (doc-driven feature, no doc section
     * number yet), not stalled behind a negotiation chat. It just starts life
     * WAITLISTED instead of PENDING: no stock is held for it and no payment
     * window runs, since there's nothing to hold yet. The moment enough
     * stock frees up — a restock, or another customer's reservation
     * expiring/being released — it's automatically promoted to PENDING (see
     * `promoteWaitlistedOrders`), which is when the hold and the payment
     * clock actually start, and the customer is emailed to come pay. The
     * storefront's own "Place Order" button lets this through deliberately
     * (it only ever blocks on an empty cart) rather than pre-guessing which
     * bucket a shortage falls into client-side — `quantityOnHandSqm` is
     * staff-only (doc 3.2), so the customer's own cart has no way to tell a
     * waitlist-able shortage from an impossible one before submitting.
     *
     * Staff placing an order *on a customer's behalf* (`dto.customerId`) keep
     * the old behavior: the order is created as PENDING right away, with the
     * shortage recorded as a message on the order itself and stock reserved
     * for the full amount regardless. Staff overriding a stock limit for a
     * customer they're actively helping is a different, legitimate call than
     * a customer's own unattended checkout hitting the same wall.
     */
    const isWaitlisted = !isStaff && shortages.length > 0;

    const subtotal = lineItems.reduce((sum, line) => sum + line.totalPrice, 0);
    // Held from the moment a non-waitlisted order exists until it's confirmed
    // onward, cancelled, or its payment verified (see `releaseReservedStock`)
    // — not until stock is actually deducted, which still only happens at
    // delivery. A waitlisted order gets this later, at promotion.
    const reservationExpiresAt = isWaitlisted
      ? null
      : new Date(Date.now() + this.reservationWindowMs());

    const shortageSummary = shortages
      .map((s) => `${s.productName} (requested ${s.requestedAreaSqm} sqm)`)
      .join('; ');

    const { order, systemMessage } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber: this.generateOrderNumber(),
          type: dto.type,
          status: isWaitlisted ? OrderStatus.WAITLISTED : OrderStatus.PENDING,
          customerId,
          createdById: actingUser.id,
          createdByType: isStaff ? OrderCreatorType.STAFF : OrderCreatorType.CUSTOMER,
          subtotal,
          total: subtotal,
          notes: dto.notes,
          quotationStatus: QuotationStatus.AWAITING_REVIEW,
          reservationExpiresAt,
          delivery: dto.delivery ? { create: dto.delivery } : undefined,
          items: {
            create: lineItems.map((line) => ({
              productId: line.product.id,
              requiredAreaSqm: line.quantity.requiredArea,
              boxes: line.quantity.completeBoxes,
              additionalPieces: line.quantity.remainingPieces,
              totalPieces: line.quantity.totalPieces,
              unitPrice: line.unitPrice,
              totalPrice: line.totalPrice,
            })),
          },
          statusEvents: {
            create: {
              status: isWaitlisted ? OrderStatus.WAITLISTED : OrderStatus.PENDING,
              createdById: actingUser.id,
              note: isWaitlisted
                ? `Order accepted and waitlisted — waiting for enough stock: ${shortageSummary}.`
                : 'Order placed.',
            },
          },
        },
        include: { items: true },
      });

      // Nothing to hold yet for a waitlisted order — see `promoteWaitlistedOrders`.
      if (!isWaitlisted) {
        const holds = lineItems.map((line) => ({
          productId: line.product.id,
          deltaAreaSqm: line.quantity.purchasedArea,
        }));
        if (shortages.length === 0) {
          // The order was judged fully covered — hold that stock only if it's
          // still there, or roll back (and `create` re-decides).
          await reserveAreaAtomically(tx, holds);
        } else {
          // Staff deliberately reserving past a shortage for a customer.
          await this.bulkAdjustProductArea(tx, 'reservedAreaSqm', holds);
        }
      }

      const message =
        shortages.length > 0
          ? await tx.orderMessage.create({
              data: {
                orderId: created.id,
                author: OrderMessageAuthor.SYSTEM,
                body: isWaitlisted
                  ? "This order is waitlisted: part of it exceeds what's currently on hand. " +
                    "We'll email you the moment there's enough stock and hold it for you. You'll then have " +
                    `${Math.round(this.reservationWindowMs() / 60_000)} minutes to complete payment once your quotation is sent.`
                  : 'Part of this order exceeds what is currently on hand. ' +
                    'Our stock team will confirm what can be released now and when the rest can follow.',
                metadata: { shortages } as unknown as Prisma.InputJsonValue,
              },
            })
          : null;

      return { order: created, systemMessage: message };
    });

    // Everything below runs after the order has committed. None of it may make
    // the request fail: the customer would be told their checkout failed while
    // the order and its stock hold exist, and a retry would create a second.
    if (systemMessage) {
      // Fired after the transaction commits — a socket push for a message
      // that then rolled back would be worse than no push at all.
      // The room holds the customer as well as staff, so what's pushed is the
      // customer-safe form — the exact available figure stays in the stored
      // message's metadata, which staff read through `listMessages`.
      await this.bestEffort(`socket push for order ${order.id}`, () =>
        this.negotiations.emitMessage('order', order.id, {
          ...systemMessage,
          metadata: withoutAvailableFigures(systemMessage.metadata),
        }),
      );
    }
    await this.bestEffort(`product cache invalidation for order ${order.id}`, () =>
      invalidateProductsCache(
        this.redis,
        lineItems.map((line) => line.product.id),
      ),
    );
    await this.bestEffort(`journey event for order ${order.id}`, async () => {
      await this.events.recordJourneyEvent({
        userId: customerId,
        sessionId: customerId,
        stage: 'PLACED_ORDER',
        metadata: { orderId: order.id },
      });
      if (shortages.length > 0) {
        await this.events.recordJourneyEvent({
          userId: customerId,
          sessionId: customerId,
          stage: 'NEGOTIATED',
          metadata: { orderId: order.id, shortages: shortages.length, waitlisted: isWaitlisted },
        });
      }
    });
    if (isWaitlisted) {
      await this.bestEffort(`waitlist email for order ${order.id}`, async () => {
        const customer = await this.prisma.user.findUniqueOrThrow({ where: { id: customerId } });
        if (customer.email) {
          await this.notifications.sendOrderWaitlistedEmail(
            customer.email,
            customer.fullName,
            order.orderNumber,
            order.id,
            customer.language,
          );
        }
      });
    }

    return {
      orderCreated: true as const,
      order: {
        ...order,
        shortages: isStaff ? shortages : shortagesForCustomer(shortages),
      },
    };
  }

  async findAll(query: QueryOrdersDto, actingUser: AuthenticatedUser) {
    const isStaff = this.isStaff(actingUser.role);
    const where: Prisma.OrderWhereInput = {
      status: query.status,
      quotationStatus: query.quotationStatus,
      customerId: isStaff ? query.customerId : actingUser.id,
      createdByType: query.createdByType,
    };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        // Same shape as `findOne` — the order list shows each item's product
        // name/image (doc-driven UI, not just a bare id), so it needs the
        // same join, not a lighter one.
        include: ORDER_INCLUDE,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(
      await Promise.all(items.map((order) => this.serializeOrder(order, actingUser.role))),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found.');

    if (!this.isStaff(actingUser.role) && order.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this order.');
    }
    return this.serializeOrder(order, actingUser.role);
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);

    if (dto.status === order.status) {
      throw new BadRequestException(`This order is already ${order.status}.`);
    }
    // One step forward along the fulfilment line, or a cancellation — no going
    // back, skipping ahead or changing a DELIVERED order. A WAITLISTED order
    // only ever leaves that status through `promoteWaitlistedOrders`: forcing
    // it to PENDING here would skip reserving its stock.
    if (!canTransitionOrderStatus(order.status, dto.status)) {
      const allowed = ORDER_STATUS_TRANSITIONS[order.status];
      throw new BadRequestException(
        order.status === OrderStatus.WAITLISTED
          ? 'This order is waitlisted for stock and will be promoted automatically once enough is available. Cancel it instead if it should no longer wait.'
          : `An order that is ${order.status} cannot move to ${dto.status}.` +
              (allowed.length > 0 ? ` It can move to: ${allowed.join(', ')}.` : ''),
      );
    }
    // Leaving PENDING onward releases the payment-window hold. That is only
    // safe once the tiles were taken out of on-hand at payment verification
    // (`verifyPayment`) — otherwise the hold would vanish with nothing
    // replacing it and another customer could reserve the same stock.
    if (
      order.status === OrderStatus.PENDING &&
      dto.status !== OrderStatus.CANCELLED &&
      order.quotationStatus !== QuotationStatus.PAYMENT_VERIFIED
    ) {
      throw new BadRequestException(
        'Verify the customer’s payment before moving this order out of PENDING — until then its stock is only held, not deducted.',
      );
    }

    // Stock normally leaves on-hand at payment verification now (see
    // `verifyPayment`); `stockDeductedAt` records that. Delivery only has to
    // move it for an order that never went through quotation payment.
    const alreadyDeducted = order.stockDeductedAt !== null;
    const deductsStock = dto.status === OrderStatus.DELIVERED && !alreadyDeducted;
    // Cancelling a paid order: its tiles were taken out of on-hand at payment
    // verification, so a cancellation puts them back.
    const returnsStock = dto.status === OrderStatus.CANCELLED && alreadyDeducted;

    if (deductsStock) {
      // Only meaningful when this call is the one about to move on-hand —
      // the goods physically left the warehouse, so on-hand must cover them.
      const short = order.items.find(
        (item) => purchasedAreaOf(item) > Number(item.product.quantityOnHandSqm),
      );
      if (short) {
        throw new BadRequestException(
          `Cannot mark delivered: "${short.product.name}" needs ${purchasedAreaOf(short)} m² but only ` +
            `${Number(short.product.quantityOnHandSqm)} m² are on hand. Restock or adjust the order first.`,
        );
      }
    }

    // Leaving PENDING for any reason — confirmed onward or cancelled — ends
    // the payment-window hold: either the order is now committed or it's
    // cancelled and the hold must go back to what other customers can buy.
    const releasesReservation =
      order.status === OrderStatus.PENDING &&
      dto.status !== OrderStatus.PENDING &&
      order.reservationExpiresAt !== null;

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // Claim the transition against the status that was validated above — a
      // concurrent change (a second click, the expiry sweep, a verification)
      // must not release or deduct the same stock twice.
      const claimed = await tx.order.updateMany({
        where: { id, status: order.status, stockDeductedAt: order.stockDeductedAt },
        data: {
          status: dto.status,
          deliveredAt: dto.status === OrderStatus.DELIVERED ? now : undefined,
          reservationExpiresAt: releasesReservation ? null : undefined,
          stockDeductedAt: deductsStock ? now : returnsStock ? null : undefined,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'This order changed while you were updating it. Refresh and try again.',
        );
      }
      await tx.orderStatusEvent.create({
        data: { orderId: id, status: dto.status, note: dto.note, createdById: actingUser.id },
      });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });

      if (deductsStock) {
        await this.deductOrderStock(tx, order, actingUser.id, 'Order delivered');
      }
      if (returnsStock) {
        await this.returnOrderStock(tx, order, actingUser.id, 'Order cancelled — stock returned');
      }
      if (releasesReservation) {
        await this.releaseReservedStock(tx, order.items);
      }

      return updated;
    });

    const productIds = order.items.map((item) => item.productId);
    if (deductsStock || returnsStock || releasesReservation) {
      await invalidateProductsCache(this.redis, productIds);
    }
    if (deductsStock) {
      await this.notifications.notifyLowStock(productIds);
    }
    if (returnsStock || releasesReservation) {
      // Stock came back (a cancelled paid order) or a hold lapsed — either
      // way there may now be room to promote a waitlisted order.
      await this.promoteWaitlistedOrders(productIds);
    }

    return result;
  }

  /**
   * Applies quantities agreed with the customer during stock negotiation.
   * Only an unconfirmed order can be revised: once processing has started the
   * physical fulfilment must be changed through a new operational workflow.
   */
  async updateItems(id: string, dto: UpdateOrderItemsDto, actingUser: AuthenticatedUser) {
    if (actingUser.role !== Role.ADMIN && actingUser.role !== Role.STOCK_MANAGER) {
      throw new ForbiddenException('Only the stock team or an administrator can edit an order.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: { include: { collection: true } } } } },
    });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.WAITLISTED) {
      throw new BadRequestException('Only pending or waitlisted orders can be edited.');
    }
    if (order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED) {
      throw new BadRequestException('This order has already been paid and verified.');
    }
    // Once the customer says they've paid, what they paid for is frozen: a
    // revision would change the amount and reset the payment behind their back.
    if (order.quotationStatus === QuotationStatus.PAYMENT_SUBMITTED) {
      throw new BadRequestException(
        'The customer has already submitted payment for this order — verify it, or cancel the order, instead of editing it.',
      );
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((item) => item.productId) } },
      include: { collection: true },
    });
    if (products.length !== dto.items.length) {
      throw new BadRequestException('One or more products could not be found.');
    }

    const revisedItems = dto.items.map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId)!;
      const quantity = calculateTileQuantity(item.areaSqm, {
        tileAreaSqm: Number(product.collection.tileAreaSqm),
        boxCoverageSqm: Number(product.boxCoverageSqm),
        piecesPerBox: product.piecesPerBox,
      });
      const unitPrice = Number(product.price);
      return {
        product,
        quantity,
        unitPrice,
        totalPrice: quantity.purchasedArea * unitPrice,
      };
    });

    // Only an order that actually holds stock has an old hold to hand back. A
    // WAITLISTED one holds nothing, so its quantity is not in
    // `reservedAreaSqm` — subtracting it would count other orders' holds as
    // available and reserve tiles that belong to them.
    const holdsStock = order.reservationExpiresAt !== null;
    const oldHeldByProduct = new Map<string, number>();
    if (holdsStock) {
      for (const item of order.items) {
        oldHeldByProduct.set(
          item.productId,
          (oldHeldByProduct.get(item.productId) ?? 0) + purchasedAreaOf(item),
        );
      }
    }

    const shortages: StockShortage[] = [];
    for (const item of revisedItems) {
      const available = availableAreaSqmOf(
        Number(item.product.quantityOnHandSqm),
        Math.max(
          0,
          Number(item.product.reservedAreaSqm) - (oldHeldByProduct.get(item.product.id) ?? 0),
        ),
      );
      if (item.quantity.purchasedArea > available) {
        shortages.push({
          productId: item.product.id,
          productName: item.product.name,
          requestedAreaSqm: item.quantity.purchasedArea,
          availableAreaSqm: available,
        });
      }
    }

    // A waitlisted order keeps its place in the queue however it is revised —
    // it never jumps to PENDING here, even if the new quantity fits right now.
    // Older waitlisted orders have first claim on free stock, so promotion is
    // left to `promoteWaitlistedOrders` (oldest first), run after this commits.
    const wasWaitlisted = order.status === OrderStatus.WAITLISTED;
    const isWaitlisted = wasWaitlisted || shortages.length > 0;
    const subtotal = revisedItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const nextStatus = isWaitlisted ? OrderStatus.WAITLISTED : OrderStatus.PENDING;
    const nextReservationExpiry = isWaitlisted
      ? null
      : new Date(Date.now() + this.reservationWindowMs());
    const productIds = [
      ...new Set([
        ...order.items.map((item) => item.productId),
        ...revisedItems.map((item) => item.product.id),
      ]),
    ];

    try {
      await this.prisma.$transaction(async (tx) => {
        const reservationDeltas: { productId: string; deltaAreaSqm: number }[] = [];
        for (const [productId, heldArea] of oldHeldByProduct) {
          reservationDeltas.push({ productId, deltaAreaSqm: -heldArea });
        }
        if (!isWaitlisted) {
          for (const item of revisedItems) {
            reservationDeltas.push({
              productId: item.product.id,
              deltaAreaSqm: item.quantity.purchasedArea,
            });
          }
        }
        // One statement covers both the old holds' release and the new ones'
        // reservation — `bulkAdjustProductArea` nets same-product entries
        // (e.g. a line whose quantity just changed) into a single delta.
        // Claim the order as it was read: a concurrent revision (or payment)
        // would otherwise release the old holds a second time. Any other write
        // to the order in between (`updatedAt` moves) makes this retry-able.
        const claimed = await tx.order.updateMany({
          where: {
            id,
            status: order.status,
            quotationStatus: order.quotationStatus,
            updatedAt: order.updatedAt,
          },
          data: { status: order.status },
        });
        if (claimed.count === 0) {
          throw new ConflictException(
            'This order changed while it was being edited. Refresh and try again.',
          );
        }
        // Only what's still available may be newly reserved; a net release always applies.
        await reserveAreaAtomically(tx, reservationDeltas);

        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.order.update({
          where: { id },
          data: {
            status: nextStatus,
            subtotal,
            total: subtotal,
            notes: dto.notes ?? order.notes,
            reservationExpiresAt: nextReservationExpiry,
            quotationStatus: QuotationStatus.AWAITING_REVIEW,
            transportFee: null,
            transportFeeNote: null,
            quotationSentAt: null,
            quotationViewedAt: null,
            paymentSubmittedAt: null,
            paymentVerifiedAt: null,
            items: {
              create: revisedItems.map((item) => ({
                productId: item.product.id,
                requiredAreaSqm: item.quantity.requiredArea,
                boxes: item.quantity.completeBoxes,
                additionalPieces: item.quantity.remainingPieces,
                totalPieces: item.quantity.totalPieces,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
              })),
            },
            statusEvents: {
              create: {
                status: nextStatus,
                createdById: actingUser.id,
                note: `Order quantities updated by ${actingUser.role === Role.ADMIN ? 'an administrator' : 'the stock team'}.`,
              },
            },
            messages: {
              create: {
                author: OrderMessageAuthor.STAFF,
                senderId: actingUser.id,
                body: isWaitlisted
                  ? shortages.length > 0
                    ? 'The order was updated, but part of the revised quantity is still waiting on stock.'
                    : 'The order was updated and remains on the waitlist — it will be promoted, in order, as soon as stock is available.'
                  : 'The order quantities were updated by the stock team. The quotation will be prepared again for the revised order.',
                metadata:
                  shortages.length > 0
                    ? ({ shortages } as unknown as Prisma.InputJsonValue)
                    : undefined,
              },
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new ConflictException(
          'Stock changed while this order was being edited. Refresh and try again.',
        );
      }
      throw error;
    }

    await invalidateProductsCache(this.redis, productIds);
    // A smaller revision, or a held order falling back to the waitlist, frees
    // stock — and a revised waitlisted order may now be next in line for it.
    await this.promoteWaitlistedOrders(productIds);
    return this.findOne(id, actingUser);
  }

  // --- Delivery details ------------------------------------------------------

  /**
   * Customers supply their own delivery details; staff can fill them in on the
   * customer's behalf. Locked once a quotation has gone out — the stock team
   * costs the transport fee against these exact details, so changing them
   * afterwards would silently invalidate a quotation the customer may already
   * be paying against.
   */
  async saveDeliveryDetails(
    id: string,
    dto: SaveDeliveryDetailsDto,
    actingUser: AuthenticatedUser,
  ) {
    this.assertCanWriteOrders(actingUser);
    const order = await this.assertAccess(id, actingUser);
    this.assertNotCancelled(order);
    if (order.quotationStatus !== QuotationStatus.AWAITING_REVIEW) {
      throw new BadRequestException(
        'Delivery details are locked once a quotation has been sent for this order.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Holds the order row for the duration, and only matches while no
      // quotation has gone out: a quotation sent between the read above and
      // this write would otherwise be costed against an address that then
      // changes underneath it.
      const open = await tx.order.updateMany({
        where: {
          id,
          quotationStatus: QuotationStatus.AWAITING_REVIEW,
          status: { not: OrderStatus.CANCELLED },
        },
        data: { updatedAt: new Date() },
      });
      if (open.count === 0) {
        throw new ConflictException(
          'A quotation was sent for this order in the meantime, so its delivery details are now locked.',
        );
      }
      return tx.orderDelivery.upsert({
        where: { orderId: id },
        create: { orderId: id, ...dto },
        update: dto,
      });
    });
  }

  // --- Quotation workflow ----------------------------------------------------

  private assertCanManageQuotation(actingUser: AuthenticatedUser) {
    if (!QUOTATION_ROLES.includes(actingUser.role)) {
      throw new ForbiddenException('Only the stock team or an administrator can do this.');
    }
  }

  /** Cancelled is terminal — nothing about the order (delivery, quotation, status) can change after it. */
  private assertNotCancelled(order: { status: OrderStatus }) {
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('This order was cancelled and can no longer be edited.');
    }
  }

  /**
   * Costs the transport and sends the quotation to the customer. Re-sending after
   * the fee has been edited is allowed, but not once payment is already in flight.
   */
  async sendQuotation(id: string, dto: SendQuotationDto, actingUser: AuthenticatedUser) {
    this.assertCanManageQuotation(actingUser);
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { customer: true, delivery: true },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);
    if (order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED) {
      throw new BadRequestException('This quotation has already been paid and verified.');
    }

    // A quotation is payable, and it locks the delivery details — so it can
    // only go out once the order is deliverable and its stock is actually held.
    if (order.status === OrderStatus.WAITLISTED) {
      throw new BadRequestException(
        'This order is waitlisted and holds no stock yet. Send the quotation once it has been promoted.',
      );
    }
    if (order.status !== OrderStatus.PENDING || order.reservationExpiresAt === null) {
      throw new BadRequestException('Stock is not held for this order, so it cannot be quoted.');
    }
    const delivery = order.delivery;
    if (
      !delivery ||
      ![delivery.contactName, delivery.phone, delivery.address, delivery.city].every(
        (field) => field.trim() !== '',
      )
    ) {
      throw new BadRequestException(
        'Delivery details (contact, phone, address and city) are required before the quotation can be sent. Add them first — they lock once it is sent.',
      );
    }
    if (order.quotationStatus === QuotationStatus.PAYMENT_SUBMITTED) {
      throw new BadRequestException(
        'The customer has already submitted payment for this quotation — verify it instead of re-sending.',
      );
    }

    const now = new Date();
    // The customer's payment window starts now, not when the order was placed
    // or promoted off the waitlist — they can't pay before this point. Only an
    // order that actually holds stock (a waitlisted one has no expiry) gets one.
    const holdsStock = order.status === OrderStatus.PENDING && order.reservationExpiresAt !== null;

    // Guarded on the same state read above: a payment submitted or a
    // cancellation landing in between must not be overwritten.
    const { count } = await this.prisma.order.updateMany({
      where: {
        id,
        status: { not: OrderStatus.CANCELLED },
        quotationStatus: { in: [QuotationStatus.AWAITING_REVIEW, QuotationStatus.QUOTATION_SENT] },
      },
      data: {
        quotationStatus: QuotationStatus.QUOTATION_SENT,
        transportFee: dto.transportFee,
        transportFeeNote: dto.transportFeeNote,
        quotationSentAt: now,
        // A re-sent quotation may differ from the one already viewed — the
        // customer has to open this version before they can mark it paid.
        quotationViewedAt: null,
        total: Number(order.subtotal) + dto.transportFee,
        reservationExpiresAt: holdsStock
          ? new Date(now.getTime() + this.reservationWindowMs())
          : undefined,
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This order changed while the quotation was being sent. Refresh and try again.',
      );
    }
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: { delivery: true },
    });

    // Best-effort, same as `notifyLowStock` — a mail failure must never
    // undo the quotation that was already sent.
    if (order.customer.email) {
      await this.notifications.sendQuotationReadyEmail(
        order.customer.email,
        order.customer.fullName,
        order.orderNumber,
        order.id,
        order.customer.language,
      );
    }

    return updated;
  }

  /**
   * Serves the quotation as a PDF, rendered fresh from the order's current
   * state — never emailed, this API call is the only way to see it (3.7).
   * The customer's own first view starts the clock on `markPaymentSubmitted`
   * below: they have to have actually seen it before they can say they paid.
   */
  async viewQuotation(id: string, actingUser: AuthenticatedUser): Promise<Buffer> {
    const order = await this.assertAccess(id, actingUser);
    if (order.quotationStatus === QuotationStatus.AWAITING_REVIEW) {
      throw new BadRequestException('No quotation has been sent for this order yet.');
    }

    const full = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: {
        items: { include: { product: { include: { collection: true } } } },
        customer: true,
        delivery: true,
      },
    });

    // A staff preview doesn't count — only the customer's own view unlocks
    // "mark as paid", so it can't be satisfied on their behalf.
    if (!order.quotationViewedAt && actingUser.id === order.customerId) {
      // Pinned to the version just rendered: if staff re-send meanwhile, this
      // view must not count for the new quotation.
      await this.prisma.order.updateMany({
        where: { id, quotationViewedAt: null, quotationSentAt: full.quotationSentAt },
        data: { quotationViewedAt: new Date() },
      });
    }

    return renderQuotationPdf({
      orderNumber: full.orderNumber,
      createdAt: full.createdAt,
      currency: full.currency,
      customer: {
        fullName: full.customer.fullName,
        email: full.customer.email,
        phone: full.customer.phone,
      },
      items: full.items.map((item) => ({
        productName: item.product.name,
        suitableFor: item.product.suitableFor,
        size: item.product.collection.size,
        areaSqm: Number(item.requiredAreaSqm),
        totalPrice: Number(item.totalPrice),
      })),
      subtotal: Number(full.subtotal),
      transportFee: full.transportFee !== null ? Number(full.transportFee) : null,
      transportFeeNote: full.transportFeeNote,
      total: Number(full.total),
      delivery: full.delivery
        ? { address: full.delivery.address, city: full.delivery.city, phone: full.delivery.phone }
        : null,
    });
  }

  /** The customer telling us they have paid — verification is a separate, staff-side step. */
  async markPaymentSubmitted(id: string, actingUser: AuthenticatedUser) {
    this.assertCanWriteOrders(actingUser);
    const order = await this.assertAccess(id, actingUser);
    this.assertNotCancelled(order);
    if (order.quotationStatus !== QuotationStatus.QUOTATION_SENT) {
      throw new BadRequestException(
        'Payment can only be submitted once a quotation has been sent for this order.',
      );
    }
    if (!order.quotationViewedAt) {
      throw new BadRequestException(
        'View the quotation first — GET /orders/:id/quotation — before confirming payment.',
      );
    }

    // Guarded so it can't land on an order the expiry sweep cancelled (or
    // staff re-quoted) after the read above. A submitted payment is exempt
    // from the sweep from here on, even if the window has already lapsed.
    const { count } = await this.prisma.order.updateMany({
      where: {
        id,
        status: { not: OrderStatus.CANCELLED },
        quotationStatus: QuotationStatus.QUOTATION_SENT,
        // The version the customer viewed is the version they're paying.
        quotationSentAt: order.quotationSentAt,
        quotationViewedAt: { not: null },
      },
      data: {
        quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
        paymentSubmittedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This order changed before your payment could be recorded. Refresh and check its status.',
      );
    }
    return this.prisma.order.findUniqueOrThrow({ where: { id } });
  }

  async verifyPayment(id: string, actingUser: AuthenticatedUser) {
    this.assertCanManageQuotation(actingUser);
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } }, customer: true },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);
    if (order.quotationStatus !== QuotationStatus.PAYMENT_SUBMITTED) {
      throw new BadRequestException('This order has no submitted payment awaiting verification.');
    }

    const releasesReservation = order.reservationExpiresAt !== null;
    // A verified payment makes the tiles the customer's — take them out of
    // on-hand stock now, not at delivery. Skipped only if some earlier step
    // already did it (there is none today, but the guard keeps it single-shot).
    const deductsStock = order.stockDeductedAt === null;
    const now = new Date();

    if (deductsStock) {
      // On-hand must physically cover the order before it's removed. It
      // normally does — a non-waitlisted order was only placed because
      // `available` covered it — but a manual stock correction since then
      // could have eaten into it, and the stock team has to reconcile that
      // before the payment can be verified.
      const short = order.items.find(
        (item) => purchasedAreaOf(item) > Number(item.product.quantityOnHandSqm),
      );
      if (short) {
        throw new BadRequestException(
          `Cannot verify payment: "${short.product.name}" needs ${purchasedAreaOf(short)} m² but only ` +
            `${Number(short.product.quantityOnHandSqm)} m² are on hand. Restock or adjust the order first.`,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Payment landing is itself "advancing" (doc: "verifying payment and
      // processing") — release the hold here even if staff hasn't separately
      // moved the fulfilment `status` off PENDING yet.
      if (releasesReservation) {
        await this.releaseReservedStock(tx, order.items);
      }
      if (deductsStock) {
        await this.deductOrderStock(tx, order, actingUser.id, 'Payment verified');
      }
      return tx.order.update({
        where: { id },
        data: {
          quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
          paymentVerifiedAt: now,
          reservationExpiresAt: releasesReservation ? null : undefined,
          stockDeductedAt: deductsStock ? now : undefined,
        },
      });
    });

    const productIds = order.items.map((item) => item.productId);
    if (releasesReservation || deductsStock) {
      await invalidateProductsCache(this.redis, productIds);
    }
    if (deductsStock) {
      await this.notifications.notifyLowStock(productIds);
    }
    if (releasesReservation) {
      // Releasing the hold and deducting the same area in one go leaves
      // `available` (on-hand − reserved) unchanged, so there is rarely new
      // room here — but a hold that had already lapsed (reservation cleared
      // when staff advanced the status earlier) still frees this on-hand up.
      await this.promoteWaitlistedOrders(productIds);
    }

    // Best-effort, same as `notifyLowStock` — a mail failure must never
    // undo the payment verification that already happened.
    if (order.customer.email) {
      await this.notifications.sendPaymentReceiptEmail(
        order.customer.email,
        order.customer.fullName,
        order.orderNumber,
        order.id,
        order.items.map((item) => ({
          name: item.product.name,
          areaSqm: Number(item.requiredAreaSqm),
          totalPrice: Number(item.totalPrice),
        })),
        Number(order.subtotal),
        Number(order.transportFee ?? 0),
        Number(order.total),
        order.currency,
        order.customer.language,
      );
    }

    return updated;
  }

  // --- Negotiation thread ----------------------------------------------------

  /**
   * Order negotiation threads are a customer <-> stock team conversation; the
   * data analyst can read orders (`isStaff`) but not what was said on them.
   * Enforced on the routes too (`@Roles`) — this keeps the service safe for
   * any other caller.
   */
  private assertCanUseNegotiation(actingUser: AuthenticatedUser) {
    if (actingUser.role === Role.DATA_ANALYST) {
      throw new ForbiddenException('Negotiations are not available for your role.');
    }
  }

  async listMessages(id: string, actingUser: AuthenticatedUser) {
    this.assertCanUseNegotiation(actingUser);
    await this.assertAccess(id, actingUser);
    const messages = await this.prisma.orderMessage.findMany({
      where: { orderId: id },
      include: { sender: { select: { id: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // A SYSTEM shortage message carries the full `shortages` (with
    // `availableAreaSqm`) in its `metadata` for the stock team — strip that
    // figure before the thread reaches the customer who owns the order.
    if (this.isStaff(actingUser.role)) return messages;
    return messages.map((message) => {
      const metadata = message.metadata as { shortages?: unknown } | null;
      if (!metadata || !Array.isArray(metadata.shortages)) return message;
      return {
        ...message,
        metadata: {
          ...metadata,
          shortages: shortagesForCustomer(metadata.shortages as StockShortage[]),
        },
      };
    });
  }

  async postMessage(id: string, dto: CreateOrderMessageDto, actingUser: AuthenticatedUser) {
    this.assertCanUseNegotiation(actingUser);
    await this.assertAccess(id, actingUser);
    const author = STAFF_ROLES.includes(actingUser.role)
      ? OrderMessageAuthor.STAFF
      : OrderMessageAuthor.CUSTOMER;

    const message = await this.prisma.orderMessage.create({
      data: { orderId: id, author, senderId: actingUser.id, body: dto.body },
      include: { sender: { select: { id: true, fullName: true, role: true } } },
    });
    this.negotiations.emitMessage('order', id, message);
    return message;
  }
}

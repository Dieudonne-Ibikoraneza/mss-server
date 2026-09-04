import {
  BadRequestException,
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
import { paginate } from '@/common/dto/pagination.dto';
import { availableAreaSqmOf, canSeeExactStock } from '@/common/utils/stock-status';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { invalidateProductsCache } from '@/products/products-cache.util';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SaveDeliveryDetailsDto } from './dto/save-delivery-details.dto';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { CreateOrderMessageDto } from './dto/create-order-message.dto';
import { UpdateOrderItemsDto } from './dto/update-order-items.dto';
import { renderQuotationPdf } from './quotation-pdf.util';
import { NegotiationsGateway } from '@/negotiations/negotiations.gateway';

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
    items: order.items.map((item) => {
      if (!item.product) return item;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { quantityOnHandSqm, reservedAreaSqm, averageCostPrice, ...productRest } = item.product;
      return { ...item, product: productRest };
    }),
  };
}

export interface StockShortage {
  productId: string;
  productName: string;
  requestedAreaSqm: number;
  availableAreaSqm: number;
}

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
  ) {}

  private generateOrderNumber() {
    return `ORD-${Date.now().toString(36).toUpperCase()}`;
  }

  private isStaff(role: Role) {
    return STAFF_ROLES.includes(role) || role === Role.DATA_ANALYST;
  }

  /** Loads an order and enforces "your own order, or you're staff". */
  private async assertAccess(orderId: string, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found.');
    if (!this.isStaff(actingUser.role) && order.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this order.');
    }
    return order;
  }

  /** How long a fresh order holds its stock — `ORDER_RESERVATION_MINUTES`, default 60. */
  private reservationWindowMs(): number {
    const minutes = this.config.get<number>('orders.reservationMinutes') ?? 60;
    return minutes * 60_000;
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
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { reservedAreaSqm: { decrement: purchasedAreaOf(item) } },
      });
    }
  }

  /**
   * The other half of stock reservations (doc-driven feature, no doc section
   * number yet): a PENDING order that's still sitting on an expired hold gets
   * auto-cancelled and its stock released, one order per transaction so a
   * single bad row can't block the rest of the sweep. Runs every minute —
   * cheap (an indexed `reservationExpiresAt` lookup) and keeps the customer's
   * wait after the window lapses short.
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
        where: { status: OrderStatus.PENDING, reservationExpiresAt: { lte: new Date() } },
        include: { items: { include: { product: true } }, customer: true },
      });
      if (expired.length === 0) return;

      for (const order of expired) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.releaseReservedStock(tx, order.items);
            await tx.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.CANCELLED,
                reservationExpiresAt: null,
                statusEvents: {
                  create: {
                    status: OrderStatus.CANCELLED,
                    note: 'Automatically cancelled — the payment window expired before this order advanced, so its stock hold was released.',
                  },
                },
              },
            });
          });

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
          // Re-read fresh — an earlier order promoted earlier in this same
          // pass may have just claimed the stock this one also needs.
          const fresh = await tx.product.findMany({
            where: { id: { in: order.items.map((item) => item.productId) } },
          });
          const byId = new Map(fresh.map((product) => [product.id, product]));

          const stillShort = order.items.some((item) => {
            const product = byId.get(item.productId)!;
            const available = availableAreaSqmOf(
              Number(product.quantityOnHandSqm),
              Number(product.reservedAreaSqm),
            );
            return purchasedAreaOf(item) > available;
          });
          if (stillShort) return false;

          for (const item of order.items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { reservedAreaSqm: { increment: purchasedAreaOf(item) } },
            });
          }

          const reservationMinutes = Math.round(this.reservationWindowMs() / 60_000);
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.PENDING,
              reservationExpiresAt: new Date(Date.now() + this.reservationWindowMs()),
              waitlistPromotedAt: new Date(),
              statusEvents: {
                create: {
                  status: OrderStatus.PENDING,
                  note:
                    'Enough stock is now available — promoted off the waitlist. ' +
                    `You have ${reservationMinutes} minutes to complete payment.`,
                },
              },
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

  async create(dto: CreateOrderDto, actingUser: AuthenticatedUser) {
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
     * Still a point-in-time read ahead of the transaction below, so it can
     * in principle race a concurrent order for the last sliver of stock —
     * accepted here the same way the rest of this codebase accepts it.
     */
    const shortages: StockShortage[] = [];
    for (const line of lineItems) {
      const availableAreaSqm = availableAreaSqmOf(
        Number(line.product.quantityOnHandSqm),
        Number(line.product.reservedAreaSqm),
      );
      if (line.quantity.purchasedArea > availableAreaSqm) {
        shortages.push({
          productId: line.product.id,
          productName: line.product.name,
          requestedAreaSqm: line.quantity.purchasedArea,
          availableAreaSqm,
        });
      }
    }

    /**
     * A customer checking out their own cart when part of it exceeds stock
     * on hand still gets a real order — accepted as a booking (doc-driven
     * feature, no doc section number yet), not stalled behind a negotiation
     * chat. It just starts life WAITLISTED instead of PENDING: no stock is
     * held for it and no payment window runs, since there's nothing to hold
     * yet. The moment enough stock frees up — a restock, or another
     * customer's reservation expiring/being released — it's automatically
     * promoted to PENDING (see `promoteWaitlistedOrders`), which is when the
     * hold and the payment clock actually start, and the customer is emailed
     * to come pay. The storefront's own "Place Order" button is already
     * disabled in this state — this mostly exists for the cases that button
     * can't catch: a stale cart snapshot, a concurrent order draining stock
     * between page load and checkout, or a direct API call.
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
      .map(
        (s) =>
          `${s.productName} (requested ${s.requestedAreaSqm} sqm, ${s.availableAreaSqm} sqm available)`,
      )
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
        for (const line of lineItems) {
          await tx.product.update({
            where: { id: line.product.id },
            data: { reservedAreaSqm: { increment: line.quantity.purchasedArea } },
          });
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
                    "We'll email you the moment there's enough stock, and you'll have " +
                    `${Math.round(this.reservationWindowMs() / 60_000)} minutes from then to complete payment.`
                  : 'Part of this order exceeds what is currently on hand. ' +
                    'Our stock team will confirm what can be released now and when the rest can follow.',
                metadata: { shortages } as unknown as Prisma.InputJsonValue,
              },
            })
          : null;

      return { order: created, systemMessage: message };
    });

    // Fired after the transaction commits — a socket push for a message
    // that then rolled back would be worse than no push at all.
    if (systemMessage) this.negotiations.emitMessage('order', order.id, systemMessage);

    await invalidateProductsCache(
      this.redis,
      lineItems.map((line) => line.product.id),
    );

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

    if (isWaitlisted) {
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
    }

    return { orderCreated: true as const, order: { ...order, shortages } };
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
      items.map((order) => sanitizeOrder(order, actingUser.role)),
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
    return sanitizeOrder(order, actingUser.role);
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);

    // A WAITLISTED order only ever leaves that status through
    // `promoteWaitlistedOrders` — manually forcing it to PENDING (or beyond)
    // here would skip reserving its stock, leaving a PENDING order with no
    // hold and no payment clock. Cancelling it outright needs no reservation
    // step, so that (and re-confirming WAITLISTED itself, a no-op) stays allowed.
    if (
      order.status === OrderStatus.WAITLISTED &&
      dto.status !== OrderStatus.WAITLISTED &&
      dto.status !== OrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'This order is waitlisted for stock and will be promoted automatically once enough is available. Cancel it instead if it should no longer wait.',
      );
    }

    if (dto.status === OrderStatus.DELIVERED) {
      // Delivering means the goods physically left the warehouse, so on-hand must cover them.
      // The reservation hold (see `releaseReservedStock`) is a separate, temporary figure —
      // this is the hard check against what's actually sitting in the warehouse.
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
    // the payment-window hold: either the order is now committed (stock
    // still only actually moves at DELIVERED, below) or it's cancelled and
    // the hold must go back to what other customers can buy.
    const releasesReservation =
      order.status === OrderStatus.PENDING &&
      dto.status !== OrderStatus.PENDING &&
      order.reservationExpiresAt !== null;

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          status: dto.status,
          deliveredAt: dto.status === OrderStatus.DELIVERED ? new Date() : undefined,
          reservationExpiresAt: releasesReservation ? null : undefined,
          statusEvents: {
            create: { status: dto.status, note: dto.note, createdById: actingUser.id },
          },
        },
      });

      if (dto.status === OrderStatus.DELIVERED) {
        for (const item of order.items) {
          const areaSqm = purchasedAreaOf(item);
          await tx.product.update({
            where: { id: item.productId },
            data: { quantityOnHandSqm: { decrement: areaSqm } },
          });
          // Leaves a trace in the movement feed the stock report reads from.
          await tx.stockAdjustment.create({
            data: {
              productId: item.productId,
              changeAreaSqm: -areaSqm,
              type: StockMovementType.OUTBOUND,
              reference: order.orderNumber,
              reason: 'Order delivered',
              adjustedById: actingUser.id,
            },
          });
          await tx.tileEvent.create({
            data: {
              userId: order.customerId,
              sessionId: order.customerId,
              productId: item.productId,
              type: 'PURCHASED',
            },
          });
        }
        await tx.customerJourneyEvent.create({
          data: { userId: order.customerId, sessionId: order.customerId, stage: 'PURCHASED' },
        });
      }

      if (releasesReservation) {
        await this.releaseReservedStock(tx, order.items);
      }

      return updated;
    });

    if (dto.status === OrderStatus.DELIVERED) {
      await invalidateProductsCache(
        this.redis,
        order.items.map((item) => item.productId),
      );
      await this.notifications.notifyLowStock(order.items.map((item) => item.productId));
    } else if (releasesReservation) {
      await invalidateProductsCache(
        this.redis,
        order.items.map((item) => item.productId),
      );
      await this.promoteWaitlistedOrders(order.items.map((item) => item.productId));
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

    const oldHeldByProduct = new Map<string, number>();
    for (const item of order.items) {
      oldHeldByProduct.set(item.productId, (oldHeldByProduct.get(item.productId) ?? 0) + purchasedAreaOf(item));
    }

    const shortages: StockShortage[] = [];
    for (const item of revisedItems) {
      const available = availableAreaSqmOf(
        Number(item.product.quantityOnHandSqm),
        Math.max(0, Number(item.product.reservedAreaSqm) - (oldHeldByProduct.get(item.product.id) ?? 0)),
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

    const isWaitlisted = shortages.length > 0;
    const subtotal = revisedItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const nextStatus = isWaitlisted ? OrderStatus.WAITLISTED : OrderStatus.PENDING;
    const nextReservationExpiry = isWaitlisted
      ? null
      : new Date(Date.now() + this.reservationWindowMs());
    const productIds = [...new Set([...order.items.map((item) => item.productId), ...revisedItems.map((item) => item.product.id)])];

    await this.prisma.$transaction(async (tx) => {
      for (const [productId, heldArea] of oldHeldByProduct) {
        if (order.reservationExpiresAt !== null) {
          await tx.product.update({ where: { id: productId }, data: { reservedAreaSqm: { decrement: heldArea } } });
        }
      }

      if (!isWaitlisted) {
        for (const item of revisedItems) {
          await tx.product.update({
            where: { id: item.product.id },
            data: { reservedAreaSqm: { increment: item.quantity.purchasedArea } },
          });
        }
      }

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
                ? 'The order was updated, but part of the revised quantity is still waiting on stock.'
                : 'The order quantities were updated by the stock team. The quotation will be prepared again for the revised order.',
              metadata: shortages.length > 0 ? { shortages } as unknown as Prisma.InputJsonValue : undefined,
            },
          },
        },
      });
    });

    await invalidateProductsCache(this.redis, productIds);
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
    const order = await this.assertAccess(id, actingUser);
    this.assertNotCancelled(order);
    if (order.quotationStatus !== QuotationStatus.AWAITING_REVIEW) {
      throw new BadRequestException(
        'Delivery details are locked once a quotation has been sent for this order.',
      );
    }

    return this.prisma.orderDelivery.upsert({
      where: { orderId: id },
      create: { orderId: id, ...dto },
      update: dto,
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
      include: { customer: true },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);
    if (order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED) {
      throw new BadRequestException('This quotation has already been paid and verified.');
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        quotationStatus: QuotationStatus.QUOTATION_SENT,
        transportFee: dto.transportFee,
        transportFeeNote: dto.transportFeeNote,
        quotationSentAt: new Date(),
        total: Number(order.subtotal) + dto.transportFee,
      },
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
      await this.prisma.order.update({ where: { id }, data: { quotationViewedAt: new Date() } });
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
    const order = await this.assertAccess(id, actingUser);
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

    return this.prisma.order.update({
      where: { id },
      data: {
        quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
        paymentSubmittedAt: new Date(),
      },
    });
  }

  async verifyPayment(id: string, actingUser: AuthenticatedUser) {
    this.assertCanManageQuotation(actingUser);
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Order not found.');
    this.assertNotCancelled(order);
    if (order.quotationStatus !== QuotationStatus.PAYMENT_SUBMITTED) {
      throw new BadRequestException('This order has no submitted payment awaiting verification.');
    }

    const releasesReservation = order.reservationExpiresAt !== null;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Payment landing is itself "advancing" (doc: "verifying payment and
      // processing") — release the hold here even if staff hasn't separately
      // moved the fulfilment `status` off PENDING yet.
      if (releasesReservation) {
        await this.releaseReservedStock(tx, order.items);
      }
      return tx.order.update({
        where: { id },
        data: {
          quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
          paymentVerifiedAt: new Date(),
          reservationExpiresAt: releasesReservation ? null : undefined,
        },
      });
    });

    if (releasesReservation) {
      await invalidateProductsCache(
        this.redis,
        order.items.map((item) => item.productId),
      );
      await this.promoteWaitlistedOrders(order.items.map((item) => item.productId));
    }

    return updated;
  }

  // --- Negotiation thread ----------------------------------------------------

  async listMessages(id: string, actingUser: AuthenticatedUser) {
    await this.assertAccess(id, actingUser);
    return this.prisma.orderMessage.findMany({
      where: { orderId: id },
      include: { sender: { select: { id: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async postMessage(id: string, dto: CreateOrderMessageDto, actingUser: AuthenticatedUser) {
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

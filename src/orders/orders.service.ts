import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { canSeeExactStock } from '@/common/utils/stock-status';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { invalidateProductsCache } from '@/products/products-cache.util';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SaveDeliveryDetailsDto } from './dto/save-delivery-details.dto';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { CreateOrderMessageDto } from './dto/create-order-message.dto';
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
      const { quantityOnHandSqm, averageCostPrice, ...productRest } = item.product;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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
     * Ordering more than is on hand is allowed on purpose: the documented user
     * journey has the customer negotiate the shortfall with the stock team
     * ("Customer negotiates" -> "Customer places an order"), and the storefront
     * lets them do exactly that. We record what is short so the order opens with
     * a negotiation thread instead of failing at checkout.
     *
     * Stock isn't reserved on placement — `quantityOnHandSqm` only moves when
     * the order is actually delivered (see `updateStatus` below) — so this
     * check is a point-in-time read, not a hold.
     */
    const shortages: StockShortage[] = [];
    for (const line of lineItems) {
      const availableAreaSqm = Number(line.product.quantityOnHandSqm);
      if (line.quantity.purchasedArea > availableAreaSqm) {
        shortages.push({
          productId: line.product.id,
          productName: line.product.name,
          requestedAreaSqm: line.quantity.purchasedArea,
          availableAreaSqm,
        });
      }
    }

    const subtotal = lineItems.reduce((sum, line) => sum + line.totalPrice, 0);

    const { order, systemMessage } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber: this.generateOrderNumber(),
          type: dto.type,
          status: OrderStatus.PENDING,
          customerId,
          createdById: actingUser.id,
          createdByType: isStaff ? OrderCreatorType.STAFF : OrderCreatorType.CUSTOMER,
          subtotal,
          total: subtotal,
          notes: dto.notes,
          quotationStatus: QuotationStatus.AWAITING_REVIEW,
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
              status: OrderStatus.PENDING,
              createdById: actingUser.id,
              note: 'Order placed.',
            },
          },
        },
        include: { items: true },
      });

      const message =
        shortages.length > 0
          ? await tx.orderMessage.create({
              data: {
                orderId: created.id,
                author: OrderMessageAuthor.SYSTEM,
                body:
                  'Part of this order exceeds what is currently on hand. ' +
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
        metadata: { orderId: order.id, shortages: shortages.length },
      });
    }

    return { ...order, shortages };
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

    if (dto.status === OrderStatus.DELIVERED) {
      // Delivering means the goods physically left the warehouse, so on-hand must cover them.
      // Stock is never reserved on placement, so this is the first hard check against it.
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

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          status: dto.status,
          deliveredAt: dto.status === OrderStatus.DELIVERED ? new Date() : undefined,
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

      // CANCELLED has no stock side effect: nothing was ever reserved on
      // placement, so there is nothing to release back.

      return updated;
    });

    if (dto.status === OrderStatus.DELIVERED) {
      await invalidateProductsCache(
        this.redis,
        order.items.map((item) => item.productId),
      );
      await this.notifications.notifyLowStock(order.items.map((item) => item.productId));
    }

    return result;
  }

  // --- Delivery details ------------------------------------------------------

  /** Customers supply their own delivery details; staff can fill them in on the customer's behalf. */
  async saveDeliveryDetails(
    id: string,
    dto: SaveDeliveryDetailsDto,
    actingUser: AuthenticatedUser,
  ) {
    await this.assertAccess(id, actingUser);

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

  /**
   * Costs the transport and sends the quotation to the customer. Re-sending after
   * the fee has been edited is allowed, but not once payment is already in flight.
   */
  async sendQuotation(id: string, dto: SendQuotationDto, actingUser: AuthenticatedUser) {
    this.assertCanManageQuotation(actingUser);
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED) {
      throw new BadRequestException('This quotation has already been paid and verified.');
    }

    return this.prisma.order.update({
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
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.quotationStatus !== QuotationStatus.PAYMENT_SUBMITTED) {
      throw new BadRequestException('This order has no submitted payment awaiting verification.');
    }

    return this.prisma.order.update({
      where: { id },
      data: {
        quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
        paymentVerifiedAt: new Date(),
      },
    });
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

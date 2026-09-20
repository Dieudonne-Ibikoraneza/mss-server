import { Injectable } from '@nestjs/common';
import { forbidden, notFound } from '@/common/errors/app-error';
import { OrderMessageAuthor, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { PaginationDto, paginate } from '@/common/dto/pagination.dto';
import { NegotiationsGateway } from '@/negotiations/negotiations.gateway';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CreateCartNegotiationDto } from './dto/create-cart-negotiation.dto';
import { CreateCartNegotiationMessageDto } from './dto/create-cart-negotiation-message.dto';

const STAFF_ROLES: Role[] = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.ADMIN];

const DETAIL_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' as const } },
  messages: {
    orderBy: { createdAt: 'asc' as const },
    include: { sender: { select: { id: true, fullName: true, role: true } } },
  },
  customer: { select: { id: true, fullName: true, email: true, phone: true } },
};

/**
 * Older SYSTEM notes (see `submit`) embedded the exact stock on hand —
 * "…Polished (Only 997 m² on hand right now., requested 1000 sqm)." That
 * figure is staff-only (doc 3.2); this drops just that fragment from a body
 * before it reaches a customer, leaving "(requested 1000 sqm)" intact.
 */
const stripStockFigureFromBody = (body: string) =>
  body.replace(/Only [\d.,]+\s*m² on hand right now\.,?\s*/gi, '');

/**
 * One chip per product, the latest. Snapshots used to be appended on every
 * submit, so older threads hold several rows for the same product — this
 * collapses them on the way out (`submit` now replaces them on the way in).
 */
const latestItemPerProduct = <T extends { productId: string; createdAt: Date }>(
  items: T[],
): T[] => {
  const latest = new Map<string, T>();
  for (const item of items) {
    const seen = latest.get(item.productId);
    if (!seen || item.createdAt >= seen.createdAt) latest.set(item.productId, item);
  }
  return items.filter((item) => latest.get(item.productId) === item);
};

/** The staff-visible note left in a thread when its customer clears their view — never shown to the customer. */
const CLEARED_NOTE =
  'The customer cleared their chat view. The earlier conversation is kept here as a record.';

/**
 * Pre-order negotiation threads: a cart the customer couldn't check out
 * because it exceeded stock on hand, negotiated with the stock team before
 * any order exists. See `CartNegotiation` in schema.prisma for why this is
 * its own model instead of reusing `OrderMessage`.
 */
@Injectable()
export class CartNegotiationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly negotiations: NegotiationsGateway,
  ) {}

  /** The data analyst is deliberately not staff here — negotiations are off-limits to that role. */
  private isStaff(role: Role) {
    return STAFF_ROLES.includes(role);
  }

  /**
   * Exact on-hand quantities are staff-only (doc 3.2) — but a shortage's
   * `availabilityNote` carries the precise figure verbatim ("Only 997 m² on
   * hand right now."). Staff get the thread untouched; the customer gets
   * every item's note flattened to a non-numeric statement before it leaves
   * the server, so the number never reaches their browser (message body,
   * item list, or raw payload).
   */
  private presentFor<
    T extends {
      customerClearedAt: Date | null;
      items: { productId: string; availabilityNote: string; createdAt: Date }[];
      messages: { body: string; createdAt: Date }[];
    },
  >(negotiation: T, actingUser: AuthenticatedUser): T {
    if (this.isStaff(actingUser.role)) {
      return { ...negotiation, items: latestItemPerProduct(negotiation.items) };
    }
    // "Clear chat" hides everything up to that moment from the customer only.
    const clearedAt = negotiation.customerClearedAt;
    const visible = <R extends { createdAt: Date }>(rows: R[]) =>
      clearedAt ? rows.filter((row) => row.createdAt > clearedAt) : rows;
    return {
      ...negotiation,
      items: latestItemPerProduct(visible(negotiation.items)).map((item) => ({
        ...item,
        availabilityNote: 'Exceeds what we currently have in stock',
      })),
      messages: visible(negotiation.messages).map((message) => ({
        ...message,
        body: stripStockFigureFromBody(message.body),
      })),
    };
  }

  private async assertAccess(id: string, actingUser: AuthenticatedUser) {
    const negotiation = await this.prisma.cartNegotiation.findUnique({ where: { id } });
    if (!negotiation) throw notFound('cartNegotiations.notFound', 'Negotiation not found.');
    if (!this.isStaff(actingUser.role) && negotiation.customerId !== actingUser.id) {
      throw forbidden('cartNegotiations.noAccess', 'You do not have access to this negotiation.');
    }
    return negotiation;
  }

  /**
   * Opens (or continues) the calling customer's negotiation thread — there is
   * at most one per customer, so a later shortage appends its items and a
   * fresh message to the same thread instead of starting a new one. The stock
   * manager then sees one running conversation per customer, not one per
   * attempt, and it is never deleted once the customer's cart clears.
   */
  async submit(dto: CreateCartNegotiationDto, actingUser: AuthenticatedUser) {
    const existing = await this.prisma.cartNegotiation.findFirst({
      where: { customerId: actingUser.id },
      orderBy: { createdAt: 'desc' },
    });
    const negotiationId =
      existing?.id ??
      (await this.prisma.cartNegotiation.create({ data: { customerId: actingUser.id } })).id;

    // Customer-visible SYSTEM note: name the products and what the customer
    // asked for, never the exact stock on hand (staff-only — see `presentFor`).
    const summary = dto.items
      .map((item) => `${item.productName} (requested ${item.requestedAreaSqm} sqm)`)
      .join('; ');

    // Later submissions replace what earlier ones said about the same product
    // (and, for a whole-cart snapshot, drop products that left the cart), so
    // staff see the current state of the cart — not every snapshot ever sent.
    const items = [...new Map(dto.items.map((item) => [item.productId, item])).values()];
    await this.prisma.$transaction([
      this.prisma.cartNegotiationItem.deleteMany({
        where: dto.snapshot
          ? { negotiationId }
          : { negotiationId, productId: { in: items.map((item) => item.productId) } },
      }),
      this.prisma.cartNegotiationItem.createMany({
        data: items.map((item) => ({
          negotiationId,
          productId: item.productId,
          productName: item.productName,
          requestedAreaSqm: item.requestedAreaSqm,
          availabilityNote: item.availabilityNote,
        })),
      }),
      this.prisma.cartNegotiationMessage.create({
        data: {
          negotiationId,
          author: OrderMessageAuthor.SYSTEM,
          body: `Cart couldn't be fully covered by stock on hand: ${summary}.`,
        },
      }),
      this.prisma.cartNegotiationMessage.create({
        data: {
          negotiationId,
          author: OrderMessageAuthor.CUSTOMER,
          senderId: actingUser.id,
          body: dto.body,
        },
      }),
      this.prisma.cartNegotiation.update({
        where: { id: negotiationId },
        data: { updatedAt: new Date() },
      }),
    ]);

    const negotiation = await this.prisma.cartNegotiation.findUniqueOrThrow({
      where: { id: negotiationId },
      include: DETAIL_INCLUDE,
    });
    // Push the tail of the thread (system note + the customer's own message)
    // so a stock manager already watching the inbox sees it appear live.
    for (const message of negotiation.messages.slice(-2)) {
      this.negotiations.emitMessage('cart', negotiationId, message);
    }
    return this.presentFor(negotiation, actingUser);
  }

  /** The calling customer's own thread, or `null` if they've never had one. */
  async mine(actingUser: AuthenticatedUser) {
    const negotiation = await this.prisma.cartNegotiation.findFirst({
      where: { customerId: actingUser.id },
      orderBy: { createdAt: 'desc' },
      include: DETAIL_INCLUDE,
    });
    if (!negotiation) return null;
    const presented = this.presentFor(negotiation, actingUser);
    // Cleared and nothing said since: to the customer it is a fresh start.
    return negotiation.customerClearedAt && presented.messages.length === 0 ? null : presented;
  }

  /**
   * The customer clearing their own view of the thread — a fresh start once
   * whatever it was about is settled. Nothing is deleted: the stock team's
   * inbox is the permanent record (see `CartNegotiation`), so this only moves
   * the point the customer's own view starts from, and leaves a note for staff.
   */
  async clearMine(actingUser: AuthenticatedUser) {
    const existing = await this.prisma.cartNegotiation.findFirst({
      where: { customerId: actingUser.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) return { cleared: false };
    // One instant for both: the note is created AT the cut-off, and the
    // customer's view only shows what is strictly after it.
    const clearedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.cartNegotiation.update({
        where: { id: existing.id },
        data: { customerClearedAt: clearedAt },
      }),
      this.prisma.cartNegotiationMessage.create({
        data: {
          negotiationId: existing.id,
          author: OrderMessageAuthor.SYSTEM,
          body: CLEARED_NOTE,
          createdAt: clearedAt,
        },
      }),
    ]);
    return { cleared: true };
  }

  async findOne(id: string, actingUser: AuthenticatedUser) {
    await this.assertAccess(id, actingUser);
    const negotiation = await this.prisma.cartNegotiation.findUniqueOrThrow({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    return this.presentFor(negotiation, actingUser);
  }

  /** Staff inbox: every customer's thread, most recently active first. */
  async findAllForStaff(query: PaginationDto) {
    const [items, total] = await Promise.all([
      this.prisma.cartNegotiation.findMany({
        include: DETAIL_INCLUDE,
        orderBy: { updatedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.cartNegotiation.count(),
    ]);
    return paginate(
      items.map((negotiation) => ({
        ...negotiation,
        items: latestItemPerProduct(negotiation.items),
      })),
      total,
      query.page,
      query.limit,
    );
  }

  async postMessage(
    id: string,
    dto: CreateCartNegotiationMessageDto,
    actingUser: AuthenticatedUser,
  ) {
    await this.assertAccess(id, actingUser);
    const author = this.isStaff(actingUser.role)
      ? OrderMessageAuthor.STAFF
      : OrderMessageAuthor.CUSTOMER;

    const [message] = await this.prisma.$transaction([
      this.prisma.cartNegotiationMessage.create({
        data: { negotiationId: id, author, senderId: actingUser.id, body: dto.body },
        include: { sender: { select: { id: true, fullName: true, role: true } } },
      }),
      this.prisma.cartNegotiation.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);

    this.negotiations.emitMessage('cart', id, message);
    return message;
  }
}

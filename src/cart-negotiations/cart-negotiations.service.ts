import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  private isStaff(role: Role) {
    return STAFF_ROLES.includes(role) || role === Role.DATA_ANALYST;
  }

  private async assertAccess(id: string, actingUser: AuthenticatedUser) {
    const negotiation = await this.prisma.cartNegotiation.findUnique({ where: { id } });
    if (!negotiation) throw new NotFoundException('Negotiation not found.');
    if (!this.isStaff(actingUser.role) && negotiation.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this negotiation.');
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

    const summary = dto.items
      .map(
        (item) =>
          `${item.productName} (${item.availabilityNote}, requested ${item.requestedAreaSqm} sqm)`,
      )
      .join('; ');

    await this.prisma.$transaction([
      this.prisma.cartNegotiationItem.createMany({
        data: dto.items.map((item) => ({
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
    return negotiation;
  }

  /** The calling customer's own thread, or `null` if they've never had one. */
  async mine(actingUser: AuthenticatedUser) {
    return this.prisma.cartNegotiation.findFirst({
      where: { customerId: actingUser.id },
      orderBy: { createdAt: 'desc' },
      include: DETAIL_INCLUDE,
    });
  }

  async findOne(id: string, actingUser: AuthenticatedUser) {
    await this.assertAccess(id, actingUser);
    return this.prisma.cartNegotiation.findUniqueOrThrow({
      where: { id },
      include: DETAIL_INCLUDE,
    });
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
    return paginate(items, total, query.page, query.limit);
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

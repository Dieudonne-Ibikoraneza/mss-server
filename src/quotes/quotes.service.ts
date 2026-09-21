import { bestEffort } from '@/redis/best-effort';
import { Injectable } from '@nestjs/common';
import { forbidden, notFound } from '@/common/errors/app-error';
import { Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { assertProductsOrderable } from '@/orders/orderable-products';
import { EventsService } from '@/events/events.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CreateQuoteRequestDto } from './dto/create-quote-request.dto';
import { UpdateQuoteStatusDto } from './dto/update-quote-status.dto';

const STAFF_ROLES: Role[] = [Role.ADMIN, Role.SALES_PERSON];

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async create(userId: string, dto: CreateQuoteRequestDto) {
    // The same rule as an order: every product must exist and still be on sale.
    // (Looking a product up with `!` turned an unknown id into a 500.)
    const requestedIds = [...new Set(dto.items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: requestedIds } },
      include: { collection: true },
    });
    assertProductsOrderable(requestedIds, products);

    const items = dto.items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;
      const quantity = calculateTileQuantity(item.areaSqm, {
        tileAreaSqm: Number(product.collection.tileAreaSqm),
        boxCoverageSqm: Number(product.boxCoverageSqm),
        piecesPerBox: product.piecesPerBox,
      });
      // Priced by area, not by the box — see `orders.service.ts#create`.
      const unitPrice = Number(product.price);
      return {
        productId: product.id,
        name: product.name,
        ...quantity,
        unitPrice,
        totalPrice: quantity.purchasedArea * unitPrice,
      };
    });

    const quote = await this.prisma.quoteRequest.create({
      data: { userId, items, notes: dto.notes },
    });

    // The request is saved; analytics are best-effort so a failure there can't cause a duplicate.
    await bestEffort('record the quotation request', () =>
      this.events.recordJourneyEvent({
        userId,
        sessionId: userId,
        stage: 'REQUESTED_QUOTATION',
      }),
    );
    return quote;
  }

  findMine(userId: string) {
    return this.prisma.quoteRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  findAll() {
    return this.prisma.quoteRequest.findMany({
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, dto: UpdateQuoteStatusDto, actingUser: AuthenticatedUser) {
    const quote = await this.prisma.quoteRequest.findUnique({ where: { id } });
    if (!quote) throw notFound('quotes.notFound', 'Quote request not found.');
    if (!STAFF_ROLES.includes(actingUser.role)) {
      throw forbidden('quotes.onlySalesCanUpdate', 'Only sales staff can update a quote status.');
    }

    const updated = await this.prisma.quoteRequest.update({
      where: { id },
      data: { status: dto.status, notes: dto.notes },
    });

    // Only once the status has really changed, and best-effort: an analytics failure must not
    // report an error for an update that was saved (or make staff repeat it).
    if (dto.status === 'NEGOTIATING') {
      await bestEffort('record the negotiation stage', () =>
        this.events.recordJourneyEvent({
          userId: quote.userId,
          sessionId: quote.userId,
          stage: 'NEGOTIATED',
        }),
      );
    }
    return updated;
  }
}

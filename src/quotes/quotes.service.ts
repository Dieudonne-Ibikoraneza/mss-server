import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
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
    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((item) => item.productId) } },
      include: { collection: true },
    });

    const items = dto.items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;
      const quantity = calculateTileQuantity(item.areaSqm, {
        tileAreaSqm: Number(product.collection.tileAreaSqm),
        boxCoverageSqm: Number(product.boxCoverageSqm),
        piecesPerBox: product.piecesPerBox,
      });
      const unitPrice = Number(product.price) / product.piecesPerBox;
      return {
        productId: product.id,
        name: product.name,
        ...quantity,
        unitPrice,
        totalPrice: quantity.totalPieces * unitPrice,
      };
    });

    const quote = await this.prisma.quoteRequest.create({
      data: { userId, items, notes: dto.notes },
    });

    await this.events.recordJourneyEvent({
      userId,
      sessionId: userId,
      stage: 'REQUESTED_QUOTATION',
    });
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
    if (!quote) throw new NotFoundException('Quote request not found.');
    if (!STAFF_ROLES.includes(actingUser.role)) {
      throw new ForbiddenException('Only sales staff can update a quote status.');
    }

    if (dto.status === 'NEGOTIATING') {
      await this.events.recordJourneyEvent({
        userId: quote.userId,
        sessionId: quote.userId,
        stage: 'NEGOTIATED',
      });
    }

    return this.prisma.quoteRequest.update({
      where: { id },
      data: { status: dto.status, notes: dto.notes },
    });
  }
}

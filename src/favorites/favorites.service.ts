import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';

@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  findAll(userId: string) {
    return this.prisma.favorite.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async add(userId: string, productId: string, sessionId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');

    const exists = await this.prisma.favorite.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (exists) throw new ConflictException('Product already saved to favorites.');

    const favorite = await this.prisma.favorite.create({ data: { userId, productId } });
    await this.events.recordTileEvent({ userId, sessionId, productId, type: 'SAVED' });
    return favorite;
  }

  async remove(userId: string, productId: string) {
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!existing) throw new NotFoundException('Favorite not found.');
    await this.prisma.favorite.delete({ where: { userId_productId: { userId, productId } } });
  }
}

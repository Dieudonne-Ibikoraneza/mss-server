import { bestEffort } from '@/redis/best-effort';
import { Injectable } from '@nestjs/common';
import { conflict, notFound } from '@/common/errors/app-error';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { ProductsService } from '@/products/products.service';

@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly products: ProductsService,
  ) {}

  async findAll(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      include: { product: { include: { collection: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // The nested product goes through the same serializer `/products` uses, so
    // its image URL is signed and `size`/`stockStatus` are present for the card.
    const products = await this.products.serializeEmbedded(
      favorites.map((favorite) => favorite.product),
    );

    return favorites.map((favorite, index) => ({
      id: favorite.id,
      productId: favorite.productId,
      createdAt: favorite.createdAt,
      product: products[index],
    }));
  }

  async add(userId: string, productId: string, sessionId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    // A retired product is gone for customers, whatever a stale tab still sends.
    if (!product?.isActive) throw notFound('catalog.productNotFound', 'Product not found.');

    const alreadySaved = () =>
      conflict('favorites.alreadySaved', 'Product already saved to favorites.');
    const exists = await this.prisma.favorite.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (exists) throw alreadySaved();

    let favorite;
    try {
      favorite = await this.prisma.favorite.create({ data: { userId, productId } });
    } catch (error) {
      // Two requests at once: the loser hit the unique constraint, not a server fault.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw alreadySaved();
      }
      throw error;
    }
    await bestEffort('record the saved favorite', () =>
      this.events.recordTileEvent({ userId, sessionId, productId, type: 'SAVED' }),
    );
    return favorite;
  }

  async remove(userId: string, productId: string) {
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!existing) throw notFound('favorites.notFound', 'Favorite not found.');
    await this.prisma.favorite.delete({ where: { userId_productId: { userId, productId } } });
  }
}

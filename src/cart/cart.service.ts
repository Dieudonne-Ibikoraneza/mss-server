import { Injectable } from '@nestjs/common';
import { badRequest, notFound } from '@/common/errors/app-error';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StorageService } from '@/storage/storage.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import {
  availableAreaSqmOf,
  getLowStockThreshold,
  stockStatusOf,
} from '@/common/utils/stock-status';
import { UpsertCartItemDto } from './dto/upsert-cart-item.dto';

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * A cart line nests the full product row (name/image/price) for the page,
   * but that row's `image` is the raw DB value — a bare private-blob path
   * like "products/<uuid>.webp" a browser can't load. `ProductsService`
   * re-signs it on every `/products` read; `cart/view` skipped that step, so
   * the thumbnail was broken for every product whose image is an upload
   * rather than an absolute seeded URL. Mirrors `ProductsService.resolveImageUrl`
   * (a separate copy, same as the orders/collections/chatbot copies).
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

  /**
   * Prisma's `upsert` isn't atomic here: two requests arriving together for a
   * customer with no cart both see "missing", both insert, and the loser fails
   * on the unique key (a 500). The row exists by then, so a second attempt is a
   * plain update and succeeds.
   */
  private async retryOnUniqueRace<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return run();
      }
      throw error;
    }
  }

  private getOrCreateCart(userId: string) {
    return this.retryOnUniqueRace(() =>
      this.prisma.cart.upsert({
        where: { userId },
        update: {},
        create: { userId },
      }),
    );
  }

  async view(userId: string) {
    const cart = await this.getOrCreateCart(userId);
    const [items, lowStockThreshold] = await Promise.all([
      this.prisma.cartItem.findMany({
        where: { cartId: cart.id },
        include: { product: { include: { collection: true } } },
      }),
      getLowStockThreshold(this.prisma),
    ]);

    const lines = await Promise.all(
      items.map(async (item) => {
        // Staff-only fields pulled out explicitly — never shown to clients (doc
        // 3.2): the exact on-hand and reserved figures, the cost, and (below) the
        // available area derived from them. A cart line carries only the
        // server-computed `exceedsStock` verdict and the `stockStatus` badge.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { collection, quantityOnHandSqm, reservedAreaSqm, averageCostPrice, ...productRest } =
          item.product;
        // Reservations held by other customers' unpaid orders count against
        // this — see `availableAreaSqmOf`.
        const availableAreaSqm = availableAreaSqmOf(
          Number(quantityOnHandSqm),
          Number(reservedAreaSqm),
        );
        const quantity = calculateTileQuantity(Number(item.areaSqm), {
          tileAreaSqm: Number(collection.tileAreaSqm),
          boxCoverageSqm: Number(productRest.boxCoverageSqm),
          piecesPerBox: productRest.piecesPerBox,
        });
        // Priced by area, not by the box: `price` is what staff enter per m²,
        // and `purchasedArea` is the actual area being billed (rounded up to
        // whole pieces) — not the raw requested `areaSqm`.
        const totalPrice = quantity.purchasedArea * Number(productRest.price);
        return {
          ...item,
          // Mirrors `ProductsService`'s serialization — a cart line's product
          // needs the same computed `size`/`stockStatus` every other product
          // response carries. The exact available area is deliberately absent:
          // whether *this line's quantity* fits is `exceedsStock` below, decided here.
          product: {
            ...productRest,
            image: await this.resolveImageUrl(productRest.image),
            collection,
            size: collection.size,
            tileAreaSqm: Number(collection.tileAreaSqm),
            stockStatus: stockStatusOf(availableAreaSqm, lowStockThreshold),
          },
          quantity,
          totalPrice,
          exceedsStock: quantity.purchasedArea > availableAreaSqm,
        };
      }),
    );

    return {
      cartId: cart.id,
      items: lines,
      total: lines.reduce((sum, line) => sum + line.totalPrice, 0),
    };
  }

  async upsertItem(userId: string, dto: UpsertCartItemDto) {
    // Only products that are on sale can be put in a cart — the catalogue
    // hides the rest, so this is a stale page or a direct request.
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      select: { isActive: true },
    });
    if (!product) throw notFound('catalog.productNotFound', 'Product not found.');
    if (!product.isActive)
      throw badRequest('cart.productUnavailable', 'This product is no longer available.');
    const cart = await this.getOrCreateCart(userId);
    return this.retryOnUniqueRace(() =>
      this.prisma.cartItem.upsert({
        where: { cartId_productId: { cartId: cart.id, productId: dto.productId } },
        update: { areaSqm: dto.areaSqm },
        create: { cartId: cart.id, productId: dto.productId, areaSqm: dto.areaSqm },
      }),
    );
  }

  async removeItem(userId: string, productId: string) {
    const cart = await this.getOrCreateCart(userId);
    const item = await this.prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
    });
    if (!item) throw notFound('cart.itemNotInCart', 'Item not in cart.');
    await this.prisma.cartItem.delete({ where: { id: item.id } });
  }

  async clear(userId: string) {
    const cart = await this.getOrCreateCart(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  }
}

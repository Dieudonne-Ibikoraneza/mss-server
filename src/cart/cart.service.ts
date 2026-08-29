import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { getLowStockThreshold, stockStatusOf } from '@/common/utils/stock-status';
import { UpsertCartItemDto } from './dto/upsert-cart-item.dto';

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  private async getOrCreateCart(userId: string) {
    return this.prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
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

    const lines = items.map((item) => {
      // averageCostPrice pulled out explicitly — never shown to clients (doc
      // 3.2). `quantityOnHandSqm` gets a narrow, deliberate exception right
      // below: unlike the public catalog (badge-only), a cart line also
      // carries the exact `availableAreaSqm` so the page can tell, live and
      // without a round trip, whether the *quantity currently typed* — not
      // just the product overall — exceeds stock. This isn't a new leak: the
      // same exact number is already returned to this same customer the
      // moment they place the order (`orders.service.ts#create`'s `shortages`).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { collection, quantityOnHandSqm, averageCostPrice, ...productRest } = item.product;
      const availableAreaSqm = Number(quantityOnHandSqm);
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
        // response carries, plus `availableAreaSqm` (see above) so the
        // shortage banner tracks the actual requested quantity, not just the
        // product's general stock badge.
        product: {
          ...productRest,
          collection,
          size: collection.size,
          tileAreaSqm: Number(collection.tileAreaSqm),
          stockStatus: stockStatusOf(availableAreaSqm, lowStockThreshold),
          availableAreaSqm,
        },
        quantity,
        totalPrice,
        exceedsStock: quantity.purchasedArea > availableAreaSqm,
      };
    });

    return {
      cartId: cart.id,
      items: lines,
      total: lines.reduce((sum, line) => sum + line.totalPrice, 0),
    };
  }

  async upsertItem(userId: string, dto: UpsertCartItemDto) {
    const cart = await this.getOrCreateCart(userId);
    return this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId: dto.productId } },
      update: { areaSqm: dto.areaSqm },
      create: { cartId: cart.id, productId: dto.productId, areaSqm: dto.areaSqm },
    });
  }

  async removeItem(userId: string, productId: string) {
    const cart = await this.getOrCreateCart(userId);
    const item = await this.prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
    });
    if (!item) throw new NotFoundException('Item not in cart.');
    await this.prisma.cartItem.delete({ where: { id: item.id } });
  }

  async clear(userId: string) {
    const cart = await this.getOrCreateCart(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  }
}

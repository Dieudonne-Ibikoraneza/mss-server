import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
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
    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: { include: { collection: true } } },
    });

    const lines = items.map((item) => {
      const quantity = calculateTileQuantity(Number(item.areaSqm), {
        tileAreaSqm: Number(item.product.collection.tileAreaSqm),
        boxCoverageSqm: Number(item.product.boxCoverageSqm),
        piecesPerBox: item.product.piecesPerBox,
      });
      const totalPrice =
        quantity.totalPieces * (Number(item.product.price) / item.product.piecesPerBox);
      return { ...item, quantity, totalPrice };
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

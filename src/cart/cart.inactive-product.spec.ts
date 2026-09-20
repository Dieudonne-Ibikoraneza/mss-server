import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service';

describe('CartService#upsertItem — only products on sale', () => {
  const build = (product: { isActive: boolean } | null) => {
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue(product) },
      cart: { upsert: jest.fn().mockResolvedValue({ id: 'cart-1' }) },
      cartItem: { upsert: jest.fn().mockResolvedValue({}) },
    };
    return { prisma, service: new CartService(prisma as never, {} as never) };
  };

  it('refuses an inactive product and saves nothing', async () => {
    const { prisma, service } = build({ isActive: false });
    await expect(service.upsertItem('u1', { productId: 'p1', areaSqm: 2 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown product rather than failing on the foreign key', async () => {
    const { service } = build(null);
    await expect(service.upsertItem('u1', { productId: 'p1', areaSqm: 2 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('still saves an active product', async () => {
    const { prisma, service } = build({ isActive: true });
    await service.upsertItem('u1', { productId: 'p1', areaSqm: 2 });
    expect(prisma.cartItem.upsert).toHaveBeenCalled();
  });
});

import { CartService } from './cart.service';

describe('CartService#view — exact stock stays staff-only', () => {
  const product = {
    id: 'p1',
    name: 'Tile',
    price: 100,
    image: 'https://example.test/x.jpg',
    boxCoverageSqm: 1,
    piecesPerBox: 4,
    // 10 on hand, 8 held by others → exactly 2 m² available.
    quantityOnHandSqm: 10,
    reservedAreaSqm: 8,
    averageCostPrice: 42,
    collection: { tileAreaSqm: 0.25, size: '50×50cm' },
  };

  const viewFor = (areaSqm: number) => {
    const prisma = {
      cart: { upsert: jest.fn().mockResolvedValue({ id: 'cart-1' }) },
      cartItem: { findMany: jest.fn().mockResolvedValue([{ id: 'i1', areaSqm, product }]) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    return new CartService(prisma as never, {} as never).view('user-1');
  };

  it('never returns the available, on-hand or reserved area or the cost', async () => {
    const cart = await viewFor(4);
    const json = JSON.stringify(cart);
    for (const key of [
      'availableAreaSqm',
      'quantityOnHandSqm',
      'reservedAreaSqm',
      'averageCostPrice',
    ]) {
      expect(json).not.toContain(key);
    }
  });

  it('still decides server-side whether a line exceeds stock', async () => {
    expect((await viewFor(4)).items[0].exceedsStock).toBe(true);
    expect((await viewFor(1)).items[0].exceedsStock).toBe(false);
  });
});

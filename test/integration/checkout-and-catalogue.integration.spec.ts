import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CartService } from '../../src/cart/cart.service';
import {
  createActors,
  createProduct,
  DELIVERY,
  makeOrders,
  orderState,
  outcome,
  placeOrder,
  prisma,
  productState,
  type Actors,
} from './harness';

/** Checkout as one operation, order references, and what may be ordered at all. */
describe('checkout and catalogue rules', () => {
  let actors: Actors;
  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  it('creates the order and its delivery details together', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const orderId = await placeOrder(makeOrders(), actors, product.id, 4);
    const delivery = await prisma.orderDelivery.findUnique({ where: { orderId } });
    expect(delivery).toMatchObject({ address: DELIVERY.address, city: DELIVERY.city });
  });

  it('leaves no order and no stock hold behind when the delivery part is invalid', async () => {
    const product = await createProduct(actors, { onHand: 10 });
    const before = await prisma.order.count({ where: { customerId: actors.customer.id } });

    const failure = await outcome(() =>
      makeOrders().create(
        {
          type: 'PURCHASE',
          items: [{ productId: product.id, areaSqm: 4 }],
          delivery: { ...DELIVERY, contactName: undefined },
        } as never,
        actors.customer,
      ),
    );

    expect(failure).not.toBe('ok');
    expect(await prisma.order.count({ where: { customerId: actors.customer.id } })).toBe(before);
    expect(await productState(product.id)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('gives simultaneous orders — even in the same millisecond — their own order numbers', async () => {
    const product = await createProduct(actors, { onHand: 100 });
    const service = makeOrders();
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    let ids: string[];
    try {
      ids = await Promise.all(
        Array.from({ length: 8 }, () => placeOrder(service, actors, product.id, 1)),
      );
    } finally {
      Date.now = realNow;
    }
    const numbers = await Promise.all(ids.map(async (id) => (await orderState(id)).orderNumber));
    expect(new Set(numbers).size).toBe(8);
  });

  describe('inactive products', () => {
    it('cannot be ordered, and the refusal names the product', async () => {
      const product = await createProduct(actors, {
        onHand: 10,
        active: false,
        name: 'Retired Tile',
      });
      const service = makeOrders();
      await expect(
        service.create(
          { type: 'PURCHASE', items: [{ productId: product.id, areaSqm: 4 }] } as never,
          actors.customer,
        ),
      ).rejects.toThrow('"Retired Tile" is no longer available');
    });

    it('cannot be put in a cart', async () => {
      const product = await createProduct(actors, { onHand: 10, active: false });
      const cart = new CartService(prisma as never, {} as never);
      expect(
        await outcome(() =>
          cart.upsertItem(actors.customer.id, { productId: product.id, areaSqm: 2 }),
        ),
      ).toBe(BadRequestException.name);
    });

    it('may stay on an existing order after being deactivated, but cannot be added to one', async () => {
      const service = makeOrders();
      const kept = await createProduct(actors, { onHand: 100 });
      const added = await createProduct(actors, { onHand: 100 });
      const orderId = await placeOrder(service, actors, kept.id, 4);
      await prisma.product.updateMany({
        where: { id: { in: [kept.id, added.id] } },
        data: { isActive: false },
      });
      const staff: AuthenticatedUser = {
        id: actors.staff.id,
        role: Role.STOCK_MANAGER,
      } as AuthenticatedUser;

      expect(
        await outcome(() =>
          service.updateItems(orderId, { items: [{ productId: kept.id, areaSqm: 6 }] }, staff),
        ),
      ).toBe('ok');
      expect(
        await outcome(() =>
          service.updateItems(
            orderId,
            {
              items: [
                { productId: kept.id, areaSqm: 6 },
                { productId: added.id, areaSqm: 2 },
              ],
            },
            staff,
          ),
        ),
      ).toBe(BadRequestException.name);
    });
  });
});

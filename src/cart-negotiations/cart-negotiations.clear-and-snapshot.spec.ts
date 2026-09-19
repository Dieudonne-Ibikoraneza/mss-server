import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CartNegotiationsService } from './cart-negotiations.service';

const customer = { id: 'customer-1', role: Role.CLIENT } as AuthenticatedUser;
const stock = { id: 'stock-1', role: Role.STOCK_MANAGER } as AuthenticatedUser;
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, minutes));

describe('CartNegotiationsService — clearing a chat keeps the staff record', () => {
  let prisma: {
    cartNegotiation: {
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    cartNegotiationMessage: { create: jest.Mock };
    cartNegotiationItem: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: CartNegotiationsService;

  const thread = {
    id: 'thread-1',
    customerId: 'customer-1',
    customerClearedAt: null as Date | null,
    items: [
      { id: 'i1', productId: 'p1', productName: 'Tile', availabilityNote: 'x', createdAt: at(1) },
      { id: 'i2', productId: 'p1', productName: 'Tile', availabilityNote: 'x', createdAt: at(5) },
      { id: 'i3', productId: 'p2', productName: 'Slab', availabilityNote: 'x', createdAt: at(2) },
    ],
    messages: [
      { id: 'm1', body: 'before', createdAt: at(1) },
      { id: 'm2', body: 'after', createdAt: at(9) },
    ],
  };

  beforeEach(() => {
    prisma = {
      cartNegotiation: {
        findFirst: jest.fn().mockResolvedValue(thread),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      cartNegotiationMessage: { create: jest.fn().mockResolvedValue({}) },
      cartNegotiationItem: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new CartNegotiationsService(prisma as never, { emitMessage: jest.fn() } as never);
  });

  it('never deletes anything — it records the moment the customer cleared, and a note for staff', async () => {
    await expect(service.clearMine(customer)).resolves.toEqual({ cleared: true });
    expect(prisma.cartNegotiation.delete).not.toHaveBeenCalled();
    expect(prisma.cartNegotiation.deleteMany).not.toHaveBeenCalled();
    const { data } = (
      prisma.cartNegotiation.update.mock.calls as [{ data: { customerClearedAt: Date } }][]
    )[0][0];
    const note = (
      prisma.cartNegotiationMessage.create.mock.calls as [
        { data: { createdAt: Date; body: string } },
      ][]
    )[0][0].data;
    expect(data.customerClearedAt).toBeInstanceOf(Date);
    // The note sits exactly at the cut-off, so the customer's own view (strictly after it) hides it.
    expect(note.createdAt).toEqual(data.customerClearedAt);
    expect(note.body).toMatch(/cleared their chat view/);
  });

  it('shows the customer only what came after they cleared; staff still see everything', async () => {
    prisma.cartNegotiation.findFirst.mockResolvedValue({ ...thread, customerClearedAt: at(5) });
    const own = await service.mine(customer);
    expect(own?.messages.map((m) => m.id)).toEqual(['m2']);

    const staffView = (await service.mine(stock)) as { messages: { id: string }[] };
    expect(staffView.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('is a fresh start (null) for the customer when nothing was said since clearing', async () => {
    prisma.cartNegotiation.findFirst.mockResolvedValue({ ...thread, customerClearedAt: at(30) });
    await expect(service.mine(customer)).resolves.toBeNull();
    // ...while the staff record is intact
    const staffView = (await service.mine(stock)) as { messages: unknown[] };
    expect(staffView.messages).toHaveLength(2);
  });

  it('collapses old duplicate item rows to one chip per product (the latest)', async () => {
    const own = await service.mine(customer);
    expect(own?.items.map((item) => item.id)).toEqual(['i2', 'i3']);
    const staffView = (await service.mine(stock)) as { items: { id: string }[] };
    expect(staffView.items.map((item) => item.id)).toEqual(['i2', 'i3']);
  });
});

describe('CartNegotiationsService#submit — snapshots replace, not append', () => {
  let prisma: {
    cartNegotiation: {
      findFirst: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    cartNegotiationMessage: { create: jest.Mock };
    cartNegotiationItem: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: CartNegotiationsService;

  const item = (productId: string, area = 5) => ({
    productId,
    productName: productId,
    requestedAreaSqm: area,
    availabilityNote: 'note',
  });

  beforeEach(() => {
    prisma = {
      cartNegotiation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'thread-1' }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'thread-1', customerClearedAt: null, items: [], messages: [] }),
      },
      cartNegotiationMessage: { create: jest.fn().mockResolvedValue({}) },
      cartNegotiationItem: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new CartNegotiationsService(prisma as never, { emitMessage: jest.fn() } as never);
  });

  it('a whole-cart snapshot clears the thread’s items first, so products that left the cart drop out', async () => {
    await service.submit({ items: [item('a'), item('b')], body: 'hi', snapshot: true }, customer);
    expect(prisma.cartNegotiationItem.deleteMany).toHaveBeenCalledWith({
      where: { negotiationId: 'thread-1' },
    });
  });

  it('a shortage message only replaces the products it names', async () => {
    await service.submit({ items: [item('a')], body: 'hi' }, customer);
    expect(prisma.cartNegotiationItem.deleteMany).toHaveBeenCalledWith({
      where: { negotiationId: 'thread-1', productId: { in: ['a'] } },
    });
  });

  it('writes one row per product even if a product is listed twice', async () => {
    await service.submit({ items: [item('a', 1), item('a', 9)], body: 'hi' }, customer);
    const { data } = (
      prisma.cartNegotiationItem.createMany.mock.calls as [
        { data: { productId: string; requestedAreaSqm: number }[] },
      ][]
    )[0][0];
    expect(data).toHaveLength(1);
    expect(data[0].requestedAreaSqm).toBe(9);
  });
});

import { BadRequestException } from '@nestjs/common';
import { OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';

describe('OrdersService#updateItems — availability for a revised order', () => {
  const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
  const product = {
    id: 'p1',
    name: 'Tile',
    price: 100,
    boxCoverageSqm: 1,
    piecesPerBox: 4,
    quantityOnHandSqm: 10,
    // Another order already holds 8 of the 10.
    reservedAreaSqm: 8,
    collection: { tileAreaSqm: 0.25 },
  };
  // 4 m² = 4 boxes of 4 pieces.
  const item = { productId: 'p1', totalPieces: 16, product };

  let prisma: {
    order: { findUnique: jest.Mock };
    product: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    order: { updateMany: jest.Mock; update: jest.Mock };
    orderItem: { deleteMany: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let service: OrdersService;
  let promote: jest.SpyInstance;

  const orderWith = (over: Record<string, unknown>) => ({
    id: 'o1',
    status: OrderStatus.WAITLISTED,
    quotationStatus: QuotationStatus.AWAITING_REVIEW,
    reservationExpiresAt: null,
    updatedAt: new Date(),
    notes: null,
    items: [item],
    ...over,
  });

  beforeEach(() => {
    tx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
      orderItem: { deleteMany: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma = {
      order: { findUnique: jest.fn() },
      product: { findMany: jest.fn().mockResolvedValue([product]) },
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    };
    service = new OrdersService(
      prisma as never,
      { delByPrefix: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(60) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    promote = jest.spyOn(service, 'promoteWaitlistedOrders').mockResolvedValue(undefined);
  });

  const revisedStatus = () =>
    (tx.order.update.mock.calls as [{ data: { status: OrderStatus } }][])[0][0].data.status;

  it("does not count a waitlisted order's own quantity as freed stock — it stays waitlisted", async () => {
    prisma.order.findUnique.mockResolvedValue(orderWith({}));
    await service.updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin);
    expect(revisedStatus()).toBe(OrderStatus.WAITLISTED);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('keeps a waitlisted order in the queue even when the revision fits right now (older orders go first)', async () => {
    prisma.product.findMany.mockResolvedValue([{ ...product, reservedAreaSqm: 0 }]);
    prisma.order.findUnique.mockResolvedValue(orderWith({}));
    await service.updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin);
    expect(revisedStatus()).toBe(OrderStatus.WAITLISTED);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    // Promotion — oldest first — is what decides who gets the free stock.
    expect(promote).toHaveBeenCalledWith(['p1']);
  });

  it('refuses to revise an order whose payment was already submitted', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderWith({
        status: OrderStatus.PENDING,
        quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
        reservationExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await expect(
      service.updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still hands back the hold of a pending order that really holds stock', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderWith({
        status: OrderStatus.PENDING,
        reservationExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await service.updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin);
    expect(revisedStatus()).toBe(OrderStatus.PENDING);
  });
});

describe('OrdersService — exact available stock never reaches a customer through an order', () => {
  const legacy =
    'Order accepted and waitlisted — waiting for enough stock: Tile (requested 4 sqm, 2 sqm available).';
  const order = {
    id: 'o1',
    customerId: 'customer-1',
    items: [],
    statusEvents: [{ note: legacy }, { note: null }, { note: 'Order placed.' }],
  };

  const notesFor = async (role: Role) => {
    const prisma = { order: { findUnique: jest.fn().mockResolvedValue(order) } };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = (await service.findOne('o1', { id: 'customer-1', role } as never)) as {
      statusEvents: { note: string | null }[];
    };
    return result.statusEvents.map((event) => event.note);
  };

  it("strips the available figure from a customer's timeline notes (older orders stored it)", async () => {
    expect(await notesFor(Role.CLIENT)).toEqual([
      'Order accepted and waitlisted — waiting for enough stock: Tile (requested 4 sqm).',
      null,
      'Order placed.',
    ]);
  });

  it('leaves the notes untouched for stock staff', async () => {
    expect((await notesFor(Role.STOCK_MANAGER))[0]).toBe(legacy);
  });
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { canTransitionOrderStatus, ORDER_STATUS_TRANSITIONS } from './order-status-transitions';
import { OrdersService } from './orders.service';

const staff = { id: 'staff-1', role: Role.STOCK_MANAGER } as AuthenticatedUser;

describe('order status transitions', () => {
  it('only ever moves one step forward or cancels', () => {
    expect(canTransitionOrderStatus(OrderStatus.PENDING, OrderStatus.PROCESSING)).toBe(true);
    expect(canTransitionOrderStatus(OrderStatus.PENDING, OrderStatus.SHIPPED)).toBe(false);
    expect(canTransitionOrderStatus(OrderStatus.SHIPPED, OrderStatus.PROCESSING)).toBe(false);
    expect(canTransitionOrderStatus(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransitionOrderStatus(OrderStatus.WAITLISTED, OrderStatus.PENDING)).toBe(false);
  });

  it('treats DELIVERED and CANCELLED as final', () => {
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.DELIVERED]).toEqual([]);
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
  });
});

describe('OrdersService#updateStatus', () => {
  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    orderStatusEvent: { create: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let service: OrdersService;

  const item = {
    productId: 'p1',
    totalPieces: 10,
    product: { boxCoverageSqm: 1, piecesPerBox: 10 },
  };
  const order = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    status: OrderStatus.PENDING,
    quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
    stockDeductedAt: new Date(),
    reservationExpiresAt: null,
    items: [item],
    ...over,
  });

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'o1' }),
      },
      orderStatusEvent: { create: jest.fn() },
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    service = new OrdersService(
      prisma as never,
      { delByPrefix: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      { notifyLowStock: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as never, 'promoteWaitlistedOrders').mockResolvedValue(undefined as never);
  });

  const run = (status: OrderStatus) => service.updateStatus('o1', { status }, staff);

  it('refuses to release an unpaid PENDING order into PROCESSING (its stock would go unprotected)', async () => {
    prisma.order.findUnique.mockResolvedValue(
      order({
        quotationStatus: QuotationStatus.QUOTATION_SENT,
        stockDeductedAt: null,
        reservationExpiresAt: new Date(),
      }),
    );
    await expect(run(OrderStatus.PROCESSING)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('still lets an unpaid PENDING order be cancelled, releasing its hold', async () => {
    prisma.order.findUnique.mockResolvedValue(
      order({
        quotationStatus: QuotationStatus.QUOTATION_SENT,
        stockDeductedAt: null,
        reservationExpiresAt: new Date(),
      }),
    );
    await run(OrderStatus.CANCELLED);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.orderStatusEvent.create).toHaveBeenCalled();
  });

  it('moves a paid PENDING order to PROCESSING without touching stock again', async () => {
    prisma.order.findUnique.mockResolvedValue(order());
    await run(OrderStatus.PROCESSING);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    [OrderStatus.PROCESSING, OrderStatus.PENDING],
    [OrderStatus.PROCESSING, OrderStatus.DELIVERED],
    [OrderStatus.DELIVERED, OrderStatus.PROCESSING],
    [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
    [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    [OrderStatus.PROCESSING, OrderStatus.PROCESSING],
  ])('rejects %s → %s', async (from, to) => {
    prisma.order.findUnique.mockResolvedValue(order({ status: from }));
    await expect(run(to)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('reports a conflict instead of double-applying when the order changed underneath', async () => {
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(run(OrderStatus.PROCESSING)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.orderStatusEvent.create).not.toHaveBeenCalled();
  });
});

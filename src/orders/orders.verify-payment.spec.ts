/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';

const staff = { id: 'staff-1', role: Role.STOCK_MANAGER } as AuthenticatedUser;

describe('OrdersService#verifyPayment — a single winner', () => {
  const item = {
    productId: 'p1',
    totalPieces: 16,
    requiredAreaSqm: 4,
    totalPrice: 400,
    product: { name: 'Tile', boxCoverageSqm: 1, piecesPerBox: 4, quantityOnHandSqm: 10 },
  };
  const order = {
    id: 'o1',
    orderNumber: 'ORD-1',
    customerId: 'c1',
    status: OrderStatus.PENDING,
    quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
    stockDeductedAt: null,
    reservationExpiresAt: new Date(Date.now() + 60_000),
    customer: { email: null },
    items: [item],
  };

  const build = (claimed: number, notifications: object = { notifyLowStock: jest.fn() }) => {
    const tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
        findUniqueOrThrow: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      stockAdjustment: { createMany: jest.fn() },
      tileEvent: { createMany: jest.fn() },
      customerJourneyEvent: { create: jest.fn() },
    };
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: jest.fn((run: (t: unknown) => unknown) => run(tx)),
    };
    const service = new OrdersService(
      prisma as never,
      { delByPrefix: jest.fn() } as never,
      {} as never,
      {} as never,
      notifications as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, tx };
  };

  it('claims the payment on the state it validated, before touching any stock', async () => {
    const { service, tx } = build(1);
    tx.order.findUniqueOrThrow.mockResolvedValue({ id: 'o1' });
    jest.spyOn(service, 'promoteWaitlistedOrders').mockResolvedValue(undefined);
    await service.verifyPayment('o1', staff);

    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
          status: { not: OrderStatus.CANCELLED },
          stockDeductedAt: null,
        }),
      }),
    );
    const claimOrder: number = tx.order.updateMany.mock.invocationCallOrder[0];
    const firstStockWrite: number = tx.$executeRaw.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(firstStockWrite);
  });

  it('a failing receipt email cannot turn a verified payment into an error', async () => {
    const receipt = jest.fn().mockRejectedValue(new Error('SMTP down'));
    const { service, tx } = build(1, {
      notifyLowStock: jest.fn(),
      sendPaymentReceiptEmail: receipt,
    });
    (
      jest.spyOn(service as never, 'promoteWaitlistedOrders' as never) as jest.SpyInstance
    ).mockResolvedValue(undefined);
    const prisma = (service as unknown as { prisma: { order: { findUnique: jest.Mock } } }).prisma;
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      customer: { email: 'a@example.test', fullName: 'A', language: 'EN' },
      subtotal: 400,
      transportFee: 0,
      total: 400,
      currency: 'RWF',
    });
    tx.order.findUniqueOrThrow.mockResolvedValue({ id: 'o1' });

    await expect(service.verifyPayment('o1', staff)).resolves.toBeDefined();
    expect(receipt).toHaveBeenCalled();
  });

  it('when it loses the claim, releases and deducts nothing and reports a conflict', async () => {
    const { service, tx } = build(0);
    await expect(service.verifyPayment('o1', staff)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.stockAdjustment.createMany).not.toHaveBeenCalled();
  });

  it('turns "stock no longer covers this" from the atomic deduction into a clear refusal', async () => {
    const { service, tx } = build(1);
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0); // release ok, deduction matched no row
    await expect(service.verifyPayment('o1', staff)).rejects.toBeInstanceOf(BadRequestException);
  });
});

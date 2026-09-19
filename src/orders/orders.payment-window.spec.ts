/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';

const user = (role: Role, id = `${role}-1`): AuthenticatedUser =>
  ({ id, role }) as AuthenticatedUser;

describe('OrdersService — the payment window runs from the quotation, and never cancels a paid order', () => {
  let prisma: {
    order: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    orderStatusEvent: { create: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let notifications: Record<string, jest.Mock>;
  let service: OrdersService;

  const item = {
    productId: 'p1',
    totalPieces: 10,
    product: { boxCoverageSqm: 1, piecesPerBox: 10 },
  };

  const updateManyArg = () =>
    (prisma.order.updateMany.mock.calls as [{ data: { reservationExpiresAt?: Date } }][])[0][0];

  beforeEach(() => {
    prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'order-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderStatusEvent: { create: jest.fn() },
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    notifications = {
      sendQuotationReadyEmail: jest.fn(),
      sendOrderReservationExpiredEmail: jest.fn(),
    };
    const config = { get: jest.fn().mockReturnValue(60) };
    service = new OrdersService(
      prisma as never,
      { del: jest.fn(), getClient: jest.fn() } as never,
      config as never,
      {} as never,
      notifications as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // The redis cache invalidation is not under test.
    jest.spyOn(service as never, 'promoteWaitlistedOrders').mockResolvedValue(undefined as never);
  });

  describe('expiry sweep', () => {
    it('only selects PENDING orders whose quotation has actually been sent', async () => {
      await service.releaseExpiredReservations();
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: OrderStatus.PENDING,
            quotationStatus: QuotationStatus.QUOTATION_SENT,
          }),
        }),
      );
    });

    it('does not cancel or release stock when the order moved on after the sweep read it', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-1', items: [item], customer: { email: 'a@b.c' } },
      ]);
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await service.releaseExpiredReservations();

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.orderStatusEvent.create).not.toHaveBeenCalled();
      expect(notifications.sendOrderReservationExpiredEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendQuotation', () => {
    const staff = user(Role.STOCK_MANAGER);
    const pendingHeld = {
      id: 'order-1',
      status: OrderStatus.PENDING,
      quotationStatus: QuotationStatus.AWAITING_REVIEW,
      reservationExpiresAt: new Date('2020-01-01'),
      subtotal: 100,
      customer: { email: null },
    };

    it('restarts the payment window for an order that holds stock', async () => {
      prisma.order.findUnique.mockResolvedValue(pendingHeld);
      const before = Date.now();

      await service.sendQuotation('order-1', { transportFee: 5 }, staff);

      const { data } = updateManyArg();
      expect(data.reservationExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
    });

    it('leaves a hold-less (waitlisted) order without an expiry', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...pendingHeld,
        status: OrderStatus.WAITLISTED,
        reservationExpiresAt: null,
      });

      await service.sendQuotation('order-1', { transportFee: 5 }, staff);

      const { data } = updateManyArg();
      expect(data.reservationExpiresAt).toBeUndefined();
    });

    it('refuses to re-send once the customer has submitted payment', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...pendingHeld,
        quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
      });
      await expect(
        service.sendQuotation('order-1', { transportFee: 5 }, staff),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('reports a conflict instead of overwriting an order that changed underneath it', async () => {
      prisma.order.findUnique.mockResolvedValue(pendingHeld);
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.sendQuotation('order-1', { transportFee: 5 }, staff),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('markPaymentSubmitted', () => {
    const customer = user(Role.CLIENT, 'customer-1');
    const sent = {
      id: 'order-1',
      customerId: 'customer-1',
      status: OrderStatus.PENDING,
      quotationStatus: QuotationStatus.QUOTATION_SENT,
      quotationViewedAt: new Date(),
    };

    it('records the payment with a guard on the current state', async () => {
      prisma.order.findUnique.mockResolvedValue(sent);
      await service.markPaymentSubmitted('order-1', customer);
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            quotationStatus: QuotationStatus.QUOTATION_SENT,
            status: { not: OrderStatus.CANCELLED },
          }),
        }),
      );
    });

    it('rejects a cancelled order', async () => {
      prisma.order.findUnique.mockResolvedValue({ ...sent, status: OrderStatus.CANCELLED });
      await expect(service.markPaymentSubmitted('order-1', customer)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('reports a conflict when the sweep cancelled the order in the meantime', async () => {
      prisma.order.findUnique.mockResolvedValue(sent);
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markPaymentSubmitted('order-1', customer)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});

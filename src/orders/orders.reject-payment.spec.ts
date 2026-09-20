/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

const staff = { id: 'staff-1', role: Role.STOCK_MANAGER } as AuthenticatedUser;

describe('rejecting a payment', () => {
  describe('the request', () => {
    const errorsFor = (reason: unknown) => validate(plainToInstance(RejectPaymentDto, { reason }));

    it('needs a real reason — not empty, not blank, not too long', async () => {
      expect(await errorsFor('Wrong amount')).toHaveLength(0);
      expect(await errorsFor('')).not.toHaveLength(0);
      expect(await errorsFor('   ')).not.toHaveLength(0);
      expect(await errorsFor(undefined)).not.toHaveLength(0);
      expect(await errorsFor('x'.repeat(501))).not.toHaveLength(0);
    });

    it('is a route for stock managers and admins only', () => {
      // Reads the route's decorator metadata; the method is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = OrdersController.prototype.rejectPayment;
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];
      expect([...roles].sort()).toEqual([Role.ADMIN, Role.STOCK_MANAGER].sort());
    });
  });

  describe('the transition', () => {
    const order = {
      id: 'o1',
      orderNumber: 'ORD-1',
      status: OrderStatus.PENDING,
      quotationStatus: QuotationStatus.PAYMENT_SUBMITTED,
      reservationExpiresAt: new Date(Date.now() - 1000),
      customer: { email: 'a@b.c', fullName: 'Amina', language: 'EN' },
    };
    const build = (claimed: number) => {
      const tx = {
        order: { updateMany: jest.fn().mockResolvedValue({ count: claimed }) },
        orderStatusEvent: { create: jest.fn() },
        orderMessage: { create: jest.fn().mockResolvedValue({ id: 'm1' }) },
      };
      const prisma = {
        order: {
          findUnique: jest.fn().mockResolvedValue(order),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'o1' }),
        },
        $transaction: jest.fn((run: (t: unknown) => unknown) => run(tx)),
      };
      const notifications = { sendPaymentRejectedEmail: jest.fn() };
      const negotiations = { emitMessage: jest.fn() };
      const service = new OrdersService(
        prisma as never,
        {} as never,
        { get: jest.fn().mockReturnValue(60) } as never,
        {} as never,
        notifications as never,
        negotiations as never,
        {} as never,
        {} as never,
      );
      return { service, tx, notifications, negotiations };
    };

    it('claims the payment on the state it validated, restarts the window, then tells the customer', async () => {
      const { service, tx, notifications, negotiations } = build(1);
      const before = Date.now();

      await service.rejectPayment('o1', { reason: '  Wrong amount  ' }, staff);

      const { where, data } = (
        tx.order.updateMany.mock.calls as [
          {
            where: Record<string, unknown>;
            data: { reservationExpiresAt: Date; paymentSubmittedAt: null; quotationStatus: string };
          },
        ][]
      )[0][0];
      expect(where).toMatchObject({ id: 'o1', quotationStatus: QuotationStatus.PAYMENT_SUBMITTED });
      expect(data.quotationStatus).toBe(QuotationStatus.QUOTATION_SENT);
      expect(data.paymentSubmittedAt).toBeNull();
      expect(data.reservationExpiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 60 * 60_000 - 1000,
      );
      expect(tx.orderMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ body: 'Payment not confirmed: Wrong amount' }),
        }),
      );
      expect(negotiations.emitMessage).toHaveBeenCalled();
      expect(notifications.sendPaymentRejectedEmail).toHaveBeenCalledWith(
        'a@b.c',
        'Amina',
        'ORD-1',
        'o1',
        'Wrong amount',
        60,
        'EN',
      );
    });

    it('when it loses the claim, writes no message and sends no email', async () => {
      const { service, tx, notifications } = build(0);
      await expect(service.rejectPayment('o1', { reason: 'x' }, staff)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.orderMessage.create).not.toHaveBeenCalled();
      expect(notifications.sendPaymentRejectedEmail).not.toHaveBeenCalled();
    });
  });
});

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentMethod, QuotationStatus, Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';

describe('PaymentsService — payment-ready order status validation', () => {
  let prisma: {
    order: { findUnique: jest.Mock };
    payment: { create: jest.Mock; findMany: jest.Mock };
  };
  let momo: { initiate: jest.Mock };
  let card: { initiate: jest.Mock };
  let service: PaymentsService;

  const customer: AuthenticatedUser = { id: 'customer-1', role: Role.CLIENT } as AuthenticatedUser;

  const baseOrder = {
    id: 'order-1',
    customerId: customer.id,
    status: OrderStatus.PENDING,
    quotationStatus: QuotationStatus.QUOTATION_SENT,
    total: 1000,
    currency: 'RWF',
  };

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn() },
      payment: { create: jest.fn(), findMany: jest.fn() },
    };
    momo = { initiate: jest.fn().mockResolvedValue({ providerRef: 'ref-1', status: 'PENDING' }) };
    card = { initiate: jest.fn().mockResolvedValue({ providerRef: 'ref-2', status: 'PENDING' }) };

    service = new PaymentsService(prisma as any, momo as any, card as any);
  });

  it('initiates a payment for an order whose quotation has been sent', async () => {
    prisma.order.findUnique.mockResolvedValue(baseOrder);
    prisma.payment.create.mockResolvedValue({});

    await service.initiate({ orderId: baseOrder.id, method: PaymentMethod.MOMO }, customer);

    expect(momo.initiate).toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalled();
  });

  it.each([
    QuotationStatus.AWAITING_REVIEW,
    QuotationStatus.PAYMENT_SUBMITTED,
    QuotationStatus.PAYMENT_VERIFIED,
  ])('rejects initiating a payment when quotationStatus is %s', async (quotationStatus) => {
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, quotationStatus });

    await expect(
      service.initiate({ orderId: baseOrder.id, method: PaymentMethod.MOMO }, customer),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(momo.initiate).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('rejects initiating a payment for a cancelled order even if a quotation was sent', async () => {
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.CANCELLED });

    await expect(
      service.initiate({ orderId: baseOrder.id, method: PaymentMethod.MOMO }, customer),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(momo.initiate).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('still enforces order access before the payment-ready check', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...baseOrder,
      customerId: 'someone-else',
      quotationStatus: QuotationStatus.AWAITING_REVIEW,
    });

    await expect(
      service.initiate({ orderId: baseOrder.id, method: PaymentMethod.MOMO }, customer),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still rejects a nonexistent order', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(
      service.initiate({ orderId: 'missing', method: PaymentMethod.MOMO }, customer),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

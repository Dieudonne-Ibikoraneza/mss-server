import { NotImplementedException } from '@nestjs/common';
import { PaymentMethod, QuotationStatus, OrderStatus, Role } from '@prisma/client';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MomoProvider } from './providers/momo.provider';
import { CardProvider } from './providers/card.provider';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';

const input = { orderId: 'order-1', amount: 1000, currency: 'RWF' };

describe('payment providers — no simulated processing', () => {
  it.each([
    ['MoMo', new MomoProvider()],
    ['card', new CardProvider()],
  ])('%s refuses with 501 instead of returning a fake reference', async (_name, provider) => {
    await expect(provider.initiate(input)).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('points customers at the manual quotation payment in the error', async () => {
    await expect(new MomoProvider().initiate(input)).rejects.toThrow(/quotation/i);
    await expect(new CardProvider().initiate(input)).rejects.toThrow(/quotation/i);
  });
});

describe('PaymentsService.initiate — a refused provider records nothing', () => {
  const customer = { id: 'customer-1', role: Role.CLIENT } as AuthenticatedUser;
  const order = {
    id: 'order-1',
    customerId: customer.id,
    status: OrderStatus.PENDING,
    quotationStatus: QuotationStatus.QUOTATION_SENT,
    total: 1000,
    currency: 'RWF',
  };

  it.each([PaymentMethod.MOMO, PaymentMethod.CARD])(
    'a %s payment for a quoted order returns 501 and creates no Payment row',
    async (method) => {
      const prisma = {
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        payment: { create: jest.fn(), findMany: jest.fn() },
      };
      const service = new PaymentsService(prisma as never, new MomoProvider(), new CardProvider());

      await expect(
        service.initiate({ orderId: order.id, method }, customer),
      ).rejects.toBeInstanceOf(NotImplementedException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    },
  );
});

describe('payment webhook is gone', () => {
  it('the controller exposes no webhook handler and no public route', () => {
    const proto = PaymentsController.prototype as unknown as Record<string, unknown>;
    expect(proto.handleWebhook).toBeUndefined();

    const routes = Object.getOwnPropertyNames(PaymentsController.prototype).filter(
      (name) => name !== 'constructor',
    );
    for (const name of routes) {
      const handler = proto[name] as object;
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    }
  });

  it('the service cannot flip a payment to SUCCEEDED/FAILED from a supplied reference', () => {
    expect(
      (PaymentsService.prototype as unknown as Record<string, unknown>).handleWebhook,
    ).toBeUndefined();
  });
});

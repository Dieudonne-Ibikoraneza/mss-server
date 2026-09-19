import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

const analyst = { id: 'analyst-1', role: Role.DATA_ANALYST } as AuthenticatedUser;

describe('the data analyst cannot change orders', () => {
  let prisma: { order: { findUnique: jest.Mock; updateMany: jest.Mock }; $transaction: jest.Mock };
  let service: OrdersService;

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it.each([
    ['placing an order', () => service.create({ items: [] } as never, analyst)],
    ['saving delivery details', () => service.saveDeliveryDetails('o1', {} as never, analyst)],
    ['declaring a payment', () => service.markPaymentSubmitted('o1', analyst)],
  ])('service refuses %s before touching any data', async (_name, act) => {
    await expect(act()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['create', 'saveDeliveryDetails', 'markPaymentSubmitted'] as const)(
    'route %s does not list the data analyst',
    (handler) => {
      // Reading the route's decorator metadata — the method is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const roles = Reflect.getMetadata(ROLES_KEY, OrdersController.prototype[handler]) as
        Role[] | undefined;
      expect(roles).toBeDefined();
      expect(roles).not.toContain(Role.DATA_ANALYST);
      expect(roles).toContain(Role.CLIENT);
    },
  );
});

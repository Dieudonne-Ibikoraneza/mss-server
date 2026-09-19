/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { ForbiddenException } from '@nestjs/common';
import { OrderMessageAuthor, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';

const user = (role: Role, id = `${role}-1`): AuthenticatedUser =>
  ({ id, role }) as AuthenticatedUser;

describe('OrdersService — order negotiation threads are off-limits to the data analyst', () => {
  let prisma: {
    order: { findUnique: jest.Mock };
    orderMessage: { findMany: jest.Mock; create: jest.Mock };
  };
  let gateway: { emitMessage: jest.Mock };
  let service: OrdersService;

  const order = { id: 'order-1', customerId: 'customer-1' };

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      orderMessage: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'm1', body: 'x' }),
      },
    };
    gateway = { emitMessage: jest.fn() };
    service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway as never,
      {} as never,
      {} as never,
    );
  });

  it('refuses to let an analyst read the thread', async () => {
    await expect(service.listMessages(order.id, user(Role.DATA_ANALYST))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.orderMessage.findMany).not.toHaveBeenCalled();
  });

  it('refuses to let an analyst post — nothing is stored or broadcast (no longer recorded as the customer)', async () => {
    await expect(
      service.postMessage(order.id, { body: 'hello' }, user(Role.DATA_ANALYST)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.orderMessage.create).not.toHaveBeenCalled();
    expect(gateway.emitMessage).not.toHaveBeenCalled();
  });

  it.each([Role.STOCK_MANAGER, Role.ADMIN, Role.SALES_PERSON])(
    'still lets a %s read and reply as staff',
    async (role) => {
      await service.listMessages(order.id, user(role));
      await service.postMessage(order.id, { body: 'on it' }, user(role));
      expect(prisma.orderMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ author: OrderMessageAuthor.STAFF }),
        }),
      );
    },
  );

  it('still lets the owning customer post, as the customer', async () => {
    await service.postMessage(order.id, { body: 'hi' }, user(Role.CLIENT, 'customer-1'));
    expect(prisma.orderMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ author: OrderMessageAuthor.CUSTOMER }),
      }),
    );
  });
});

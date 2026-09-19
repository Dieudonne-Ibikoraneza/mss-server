/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { ForbiddenException } from '@nestjs/common';
import { OrderMessageAuthor, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CartNegotiationsService } from './cart-negotiations.service';

const user = (role: Role, id = `${role}-1`): AuthenticatedUser =>
  ({ id, role }) as AuthenticatedUser;

describe('CartNegotiationsService — data analyst has no access', () => {
  let prisma: {
    cartNegotiation: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
    cartNegotiationMessage: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let gateway: { emitMessage: jest.Mock };
  let service: CartNegotiationsService;

  const thread = { id: 'thread-1', customerId: 'customer-1' };

  beforeEach(() => {
    prisma = {
      cartNegotiation: {
        findUnique: jest.fn().mockResolvedValue(thread),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...thread, items: [], messages: [] }),
        update: jest.fn().mockResolvedValue({}),
      },
      cartNegotiationMessage: { create: jest.fn().mockResolvedValue({ id: 'm1' }) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    gateway = { emitMessage: jest.fn() };
    service = new CartNegotiationsService(prisma as never, gateway as never);
  });

  it('refuses to let an analyst read a thread', async () => {
    await expect(service.findOne(thread.id, user(Role.DATA_ANALYST))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.cartNegotiation.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('refuses to let an analyst post — nothing is stored or broadcast', async () => {
    await expect(
      service.postMessage(thread.id, { body: 'hello' }, user(Role.DATA_ANALYST)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.cartNegotiationMessage.create).not.toHaveBeenCalled();
    expect(gateway.emitMessage).not.toHaveBeenCalled();
  });

  it.each([Role.STOCK_MANAGER, Role.ADMIN, Role.SALES_PERSON])(
    'still lets a %s read and reply as staff',
    async (role) => {
      await expect(service.findOne(thread.id, user(role))).resolves.toBeDefined();
      await service.postMessage(thread.id, { body: 'on it' }, user(role));
      expect(prisma.cartNegotiationMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ author: OrderMessageAuthor.STAFF }),
        }),
      );
      expect(gateway.emitMessage).toHaveBeenCalledWith('cart', thread.id, expect.anything());
    },
  );

  it('still lets the owning customer post, as the customer', async () => {
    await service.postMessage(thread.id, { body: 'hi' }, user(Role.CLIENT, 'customer-1'));
    expect(prisma.cartNegotiationMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ author: OrderMessageAuthor.CUSTOMER }),
      }),
    );
  });

  it("still refuses another customer's thread", async () => {
    await expect(
      service.findOne(thread.id, user(Role.CLIENT, 'someone-else')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

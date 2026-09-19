import { ExecutionContext, ForbiddenException, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { CartNegotiationsController } from '@/cart-negotiations/cart-negotiations.controller';
import { OrdersController } from '@/orders/orders.controller';
import { NegotiationInboxController } from '@/negotiation-inbox/negotiation-inbox.controller';

/** Runs the real `RolesGuard` against a controller method's actual `@Roles` metadata. */
const isAllowed = (controller: Type<object>, handler: string, role: Role): boolean => {
  const context = {
    getHandler: () => (controller.prototype as Record<string, () => void>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
  } as unknown as ExecutionContext;
  try {
    return new RolesGuard(new Reflector()).canActivate(context);
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
};

describe('negotiation routes — role wiring', () => {
  const cartRoutes = ['submit', 'mine', 'clearMine', 'findAll', 'findOne', 'postMessage'];

  it.each(cartRoutes)('cart-negotiations %s is 403 for the data analyst', (handler) => {
    expect(isAllowed(CartNegotiationsController, handler, Role.DATA_ANALYST)).toBe(false);
  });

  it.each(['listMessages', 'postMessage'])('orders %s is 403 for the data analyst', (handler) => {
    expect(isAllowed(OrdersController, handler, Role.DATA_ANALYST)).toBe(false);
  });

  it.each([Role.CLIENT, Role.SALES_PERSON, Role.STOCK_MANAGER, Role.ADMIN])(
    'a %s can still use the customer/staff negotiation routes',
    (role) => {
      for (const handler of ['submit', 'mine', 'clearMine', 'findOne', 'postMessage']) {
        expect(isAllowed(CartNegotiationsController, handler, role)).toBe(true);
      }
      for (const handler of ['listMessages', 'postMessage']) {
        expect(isAllowed(OrdersController, handler, role)).toBe(true);
      }
    },
  );

  it('the staff inbox list stays admin + stock manager only', () => {
    expect(isAllowed(CartNegotiationsController, 'findAll', Role.STOCK_MANAGER)).toBe(true);
    expect(isAllowed(CartNegotiationsController, 'findAll', Role.ADMIN)).toBe(true);
    expect(isAllowed(CartNegotiationsController, 'findAll', Role.CLIENT)).toBe(false);
  });

  it('the analyst can still read orders themselves (only the conversation on them is blocked)', () => {
    expect(isAllowed(OrdersController, 'findOne', Role.DATA_ANALYST)).toBe(true);
  });

  describe('staff negotiation inbox', () => {
    it.each(['list', 'summary'])('%s is 403 for the analyst, sales and customers', (handler) => {
      for (const role of [Role.DATA_ANALYST, Role.SALES_PERSON, Role.CLIENT]) {
        expect(isAllowed(NegotiationInboxController, handler, role)).toBe(false);
      }
    });

    it.each(['list', 'summary'])('%s is open to stock managers and admins', (handler) => {
      for (const role of [Role.STOCK_MANAGER, Role.ADMIN]) {
        expect(isAllowed(NegotiationInboxController, handler, role)).toBe(true);
      }
    });
  });
});

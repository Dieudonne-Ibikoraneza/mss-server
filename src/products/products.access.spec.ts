import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { ProductsController } from './products.controller';

const canAccess = (handler: keyof ProductsController, role?: Role) => {
  const context = {
    getHandler: () =>
      (ProductsController.prototype as unknown as Record<string, () => void>)[handler],
    getClass: () => ProductsController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
  return new RolesGuard(new Reflector()).canActivate(context);
};

describe('product management permissions', () => {
  it.each(['create', 'update', 'remove'] as const)('%s is restricted to admins', (handler) => {
    expect(canAccess(handler, Role.ADMIN)).toBe(true);
    for (const role of [
      undefined,
      Role.STOCK_MANAGER,
      Role.CLIENT,
      Role.SALES_PERSON,
      Role.DATA_ANALYST,
    ]) {
      expect(() => canAccess(handler, role)).toThrow(ForbiddenException);
    }
  });

  it.each(['adjustStock', 'reactivate', 'uploadImage'] as const)(
    '%s remains available to admins and stock managers',
    (handler) => {
      for (const role of [Role.ADMIN, Role.STOCK_MANAGER]) {
        expect(canAccess(handler, role)).toBe(true);
      }
      expect(() => canAccess(handler, Role.CLIENT)).toThrow(ForbiddenException);
    },
  );
});

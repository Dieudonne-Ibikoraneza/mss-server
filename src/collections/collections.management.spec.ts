import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { StorageService } from '@/storage/storage.service';
import { TranslationService } from '@/translation/translation.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

const canAccess = (handler: keyof CollectionsController, role?: Role) => {
  const context = {
    getHandler: () =>
      (CollectionsController.prototype as unknown as Record<string, () => void>)[handler],
    getClass: () => CollectionsController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
  return new RolesGuard(new Reflector()).canActivate(context);
};

describe('collection management', () => {
  it.each(['create', 'update', 'remove'] as const)('%s is admin-only', (handler) => {
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

  it('reactivates the collection and refreshes caches without changing products', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'collection', isActive: true });
    const productUpdate = jest.fn();
    const del = jest.fn();
    const delByPrefix = jest.fn();
    const service = new CollectionsService(
      {
        collection: { findUnique: jest.fn().mockResolvedValue({ id: 'collection' }), update },
        product: { update: productUpdate },
      } as unknown as PrismaService,
      { del, delByPrefix } as unknown as RedisService,
      {} as StorageService,
      { translateFields: jest.fn().mockResolvedValue({}) } as unknown as TranslationService,
    );
    await expect(service.update('collection', { isActive: true })).resolves.toMatchObject({
      isActive: true,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: true }) as unknown,
      }),
    );
    expect(productUpdate).not.toHaveBeenCalled();
    expect(delByPrefix).toHaveBeenCalledWith('cache:collections:list:');
    expect(del).toHaveBeenCalledWith('cache:collections:detail:v2:collection');
  });
});

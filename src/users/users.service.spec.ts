/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.any(...)` matchers are typed `any` */
import { UsersService } from './users.service';

describe('UsersService — setStaffStatus revokes sessions on deactivation', () => {
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifications: object;
  let service: UsersService;

  const staffMember = { id: 'staff-1', role: 'SALES_PERSON', status: 'ACTIVE' };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(staffMember),
        update: jest.fn().mockResolvedValue({ ...staffMember, status: 'INACTIVE' }),
      },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      // The service works inside an interactive transaction; here the transaction client is this same mock.
      $transaction: jest.fn((run: (tx: unknown) => unknown) => run(prisma)),
    };
    notifications = {};
    service = new UsersService(prisma as never, notifications as never);
  });

  it('revokes all active refresh tokens when deactivating a staff member', async () => {
    await service.setStaffStatus('staff-1', 'INACTIVE', 'admin-1');

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'staff-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      data: { status: 'INACTIVE' },
      select: expect.any(Object),
    });
  });

  it('does not touch refresh tokens when reactivating a staff member', async () => {
    await service.setStaffStatus('staff-1', 'ACTIVE', 'admin-1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects self-deactivation without touching the database', async () => {
    await expect(service.setStaffStatus('admin-1', 'INACTIVE', 'admin-1')).rejects.toThrow(
      'You cannot deactivate your own account.',
    );
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

import { Role, UserStatus } from '@prisma/client';
import { UsersService } from '../../src/users/users.service';
import { outcome, prisma } from './harness';

/**
 * The last active admin must not be able to close their own account, even when
 * two admins try it at the same instant.
 */
describe('closing your own account keeps at least one active admin', () => {
  const users = new UsersService(prisma as never, {} as never);
  const tag = `la${Date.now().toString(36)}`;
  let n = 0;
  const makeUser = (role: Role) =>
    prisma.user.create({
      data: {
        fullName: `IT ${role}`,
        email: `${tag}-${n++}@example.test`,
        phone: `+2507${(Date.now() % 10000000).toString().padStart(7, '0')}${n}`,
        role,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    });
  const status = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    // Other suites' admins would hide the situation under test.
    await prisma.user.updateMany({
      where: { role: Role.ADMIN },
      data: { status: UserStatus.INACTIVE },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('a customer can always close their account', async () => {
    const customer = await makeUser(Role.CLIENT);
    await users.closeOwnAccount(customer.id);
    expect(await status(customer.id)).toBe(UserStatus.INACTIVE);
  });

  it('the only active admin is refused and stays active', async () => {
    const admin = await makeUser(Role.ADMIN);
    expect(await outcome(() => users.closeOwnAccount(admin.id))).toBe('BadRequestException');
    expect(await status(admin.id)).toBe(UserStatus.ACTIVE);
  });

  it('with a second active admin, one can close — and then the other is the last', async () => {
    const other = await prisma.user.findFirstOrThrow({
      where: { role: Role.ADMIN, status: UserStatus.ACTIVE },
    });
    const second = await makeUser(Role.ADMIN);
    expect(await outcome(() => users.closeOwnAccount(second.id))).toBe('ok');
    expect(await outcome(() => users.closeOwnAccount(other.id))).toBe('BadRequestException');
    expect(await status(other.id)).toBe(UserStatus.ACTIVE);
  });

  it('two admins closing at the same instant: exactly one succeeds, one admin remains', async () => {
    await prisma.user.updateMany({
      where: { role: Role.ADMIN },
      data: { status: UserStatus.INACTIVE },
    });
    const [a, b] = [await makeUser(Role.ADMIN), await makeUser(Role.ADMIN)];
    const results = await Promise.all([
      outcome(() => users.closeOwnAccount(a.id)),
      outcome(() => users.closeOwnAccount(b.id)),
    ]);
    expect(results.sort()).toEqual(['BadRequestException', 'ok']);
    expect(
      await prisma.user.count({ where: { role: Role.ADMIN, status: UserStatus.ACTIVE } }),
    ).toBe(1);
  });

  describe('changing another way: demote or deactivate', () => {
    const resetAdmins = () =>
      prisma.user.updateMany({
        where: { role: Role.ADMIN },
        data: { status: UserStatus.INACTIVE },
      });
    const role = async (id: string) =>
      (await prisma.user.findUniqueOrThrow({ where: { id } })).role;

    it('the only admin cannot demote themselves', async () => {
      await resetAdmins();
      const admin = await makeUser(Role.ADMIN);
      expect(await outcome(() => users.updateStaff(admin.id, { role: Role.SALES_PERSON }))).toBe(
        'BadRequestException',
      );
      expect(await role(admin.id)).toBe(Role.ADMIN);
      // Other edits are still fine, and so is a non-admin's role.
      expect(await outcome(() => users.updateStaff(admin.id, { fullName: 'Renamed Admin' }))).toBe(
        'ok',
      );
    });

    it('with a second admin, one can be demoted — but not the last one left', async () => {
      await resetAdmins();
      const [a, b] = [await makeUser(Role.ADMIN), await makeUser(Role.ADMIN)];
      expect(await outcome(() => users.updateStaff(a.id, { role: Role.DATA_ANALYST }))).toBe('ok');
      expect(await outcome(() => users.updateStaff(b.id, { role: Role.DATA_ANALYST }))).toBe(
        'BadRequestException',
      );
      expect(await role(b.id)).toBe(Role.ADMIN);
    });

    it('two admins demoting each other at the same instant: one admin remains', async () => {
      await resetAdmins();
      const [a, b] = [await makeUser(Role.ADMIN), await makeUser(Role.ADMIN)];
      const results = await Promise.all([
        outcome(() => users.updateStaff(a.id, { role: Role.SALES_PERSON })),
        outcome(() => users.updateStaff(b.id, { role: Role.SALES_PERSON })),
      ]);
      expect(results.sort()).toEqual(['BadRequestException', 'ok']);
      expect(
        await prisma.user.count({ where: { role: Role.ADMIN, status: UserStatus.ACTIVE } }),
      ).toBe(1);
    });

    it('two admins deactivating each other at the same instant: one admin remains', async () => {
      await resetAdmins();
      const [a, b] = [await makeUser(Role.ADMIN), await makeUser(Role.ADMIN)];
      const results = await Promise.all([
        outcome(() => users.setStaffStatus(a.id, 'INACTIVE', b.id)),
        outcome(() => users.setStaffStatus(b.id, 'INACTIVE', a.id)),
      ]);
      expect(results.sort()).toEqual(['BadRequestException', 'ok']);
      expect(
        await prisma.user.count({ where: { role: Role.ADMIN, status: UserStatus.ACTIVE } }),
      ).toBe(1);
    });
  });
});

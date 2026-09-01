import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { paginate } from '@/common/dto/pagination.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryStaffDto, QueryCustomersDto } from './dto/query-users.dto';

const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  language: true,
  heardAboutUs: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const STAFF_ROLES: Role[] = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.DATA_ANALYST, Role.ADMIN];

/** Orders that count towards a customer's spend — anything not cancelled. */
const SPENDING_STATUSES = { not: OrderStatus.CANCELLED } as const;

const searchFilter = (search?: string): Prisma.UserWhereInput =>
  search
    ? {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  updateProfile(id: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({ where: { id }, data: dto, select: SAFE_USER_SELECT });
  }

  /**
   * Account closure from the customer's own settings screen. Deactivates rather
   * than hard-deleting: orders, payments and stock movements must stay
   * attributable, so the account is switched off and every session revoked.
   */
  async closeOwnAccount(id: string) {
    await this.findById(id);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { status: UserStatus.INACTIVE },
        select: SAFE_USER_SELECT,
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return user;
  }

  async listStaff(query: QueryStaffDto) {
    const where: Prisma.UserWhereInput = {
      role: query.role ?? { in: STAFF_ROLES },
      status: query.status,
      ...searchFilter(query.search),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items, total, query.page, query.limit);
  }

  /** Headline counts for the staff directory's role cards. */
  async staffSummary() {
    const rows = await this.prisma.user.groupBy({
      by: ['role'],
      where: { role: { in: STAFF_ROLES } },
      _count: { _all: true },
    });

    const byRole = STAFF_ROLES.map((role) => ({
      role,
      count: rows.find((row) => row.role === role)?._count._all ?? 0,
    }));

    return { byRole, total: byRole.reduce((sum, row) => sum + row.count, 0) };
  }

  async createStaff(dto: CreateStaffDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone already exists.');
    }

    const staff = await this.prisma.user.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        phone: dto.phone,
        role: dto.role,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
      select: SAFE_USER_SELECT,
    });

    // Best-effort: the account is already created either way, so a notification hiccup shouldn't fail the request.
    try {
      await this.notifications.sendStaffAccountCreatedEmail(
        staff.email!,
        staff.fullName,
        staff.role,
        staff.language,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send staff welcome email to ${staff.email}: ${message}`);
    }

    return staff;
  }

  /** Shared existence + role guard for the staff-only mutations below. */
  private async findStaffById(id: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id, role: { in: STAFF_ROLES } },
      select: SAFE_USER_SELECT,
    });
    if (!staff) throw new NotFoundException('Staff member not found.');
    return staff;
  }

  async updateStaff(id: string, dto: UpdateStaffDto) {
    await this.findStaffById(id);
    if (dto.phone) {
      const existing = await this.prisma.user.findFirst({
        where: { phone: dto.phone, id: { not: id } },
      });
      if (existing) throw new ConflictException('Another account already uses this phone number.');
    }
    return this.prisma.user.update({ where: { id }, data: dto, select: SAFE_USER_SELECT });
  }

  async setStaffStatus(id: string, status: 'ACTIVE' | 'INACTIVE', currentUserId: string) {
    if (id === currentUserId && status === 'INACTIVE') {
      throw new BadRequestException('You cannot deactivate your own account.');
    }
    await this.findStaffById(id);
    return this.prisma.user.update({ where: { id }, data: { status }, select: SAFE_USER_SELECT });
  }

  /**
   * Customer directory for sales and admin, with the spend figures the list
   * shows. Aggregated in one grouped query rather than per row, so the page
   * stays a fixed number of round trips regardless of page size.
   */
  async listCustomers(query: QueryCustomersDto) {
    const where: Prisma.UserWhereInput = {
      role: Role.CLIENT,
      status: query.status,
      ...searchFilter(query.search),
    };

    // `spend` can't be paginated in the database — it isn't a column, it's
    // an aggregate over orders — so this path pulls every matching customer,
    // ranks them in memory, and pages that ranked list. Fine at this scale
    // (a customer base, not an events table); `newest` stays a cheap
    // single-page query for the common case.
    if (query.sort === 'spend') {
      const [items, allStats] = await Promise.all([
        this.prisma.user.findMany({ where, select: SAFE_USER_SELECT }),
        this.prisma.order.groupBy({
          by: ['customerId'],
          where: { status: SPENDING_STATUSES },
          _sum: { total: true },
          _count: { _all: true },
          _max: { createdAt: true },
          _min: { createdAt: true },
        }),
      ]);

      const withStats = items
        .map((customer) => {
          const row = allStats.find((entry) => entry.customerId === customer.id);
          return {
            ...customer,
            orderCount: row?._count._all ?? 0,
            lifetimeSpend: Number(row?._sum.total ?? 0),
            firstOrderAt: row?._min.createdAt ?? null,
            lastOrderAt: row?._max.createdAt ?? null,
          };
        })
        .sort((a, b) => b.lifetimeSpend - a.lifetimeSpend);

      const page = withStats.slice(query.skip, query.skip + query.limit);
      return paginate(page, withStats.length, query.page, query.limit);
    }

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    const stats = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: { customerId: { in: items.map((item) => item.id) }, status: SPENDING_STATUSES },
      _sum: { total: true },
      _count: { _all: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
    });

    const withStats = items.map((customer) => {
      const row = stats.find((entry) => entry.customerId === customer.id);
      return {
        ...customer,
        orderCount: row?._count._all ?? 0,
        lifetimeSpend: Number(row?._sum.total ?? 0),
        firstOrderAt: row?._min.createdAt ?? null,
        lastOrderAt: row?._max.createdAt ?? null,
      };
    });

    return paginate(withStats, total, query.page, query.limit);
  }

  /** A single customer with their spend summary and recent orders, for the detail screen. */
  async findCustomer(id: string, recentOrders = 10) {
    const customer = await this.prisma.user.findFirst({
      where: { id, role: Role.CLIENT },
      select: SAFE_USER_SELECT,
    });
    if (!customer) throw new NotFoundException('Customer not found.');

    const [aggregate, orders, favorites, designs] = await Promise.all([
      this.prisma.order.aggregate({
        where: { customerId: id, status: SPENDING_STATUSES },
        _sum: { total: true },
        _count: { _all: true },
        _max: { createdAt: true },
        _min: { createdAt: true },
      }),
      this.prisma.order.findMany({
        where: { customerId: id },
        include: { items: true, delivery: true },
        orderBy: { createdAt: 'desc' },
        take: recentOrders,
      }),
      this.prisma.favorite.count({ where: { userId: id } }),
      this.prisma.roomDesign.count({ where: { userId: id } }),
    ]);

    return {
      ...customer,
      orderCount: aggregate._count._all,
      lifetimeSpend: Number(aggregate._sum.total ?? 0),
      firstOrderAt: aggregate._min.createdAt ?? null,
      lastOrderAt: aggregate._max.createdAt ?? null,
      favoriteCount: favorites,
      savedDesignCount: designs,
      orders,
    };
  }
}

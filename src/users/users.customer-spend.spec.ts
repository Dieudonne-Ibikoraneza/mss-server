import { Prisma, Role } from '@prisma/client';
import { UsersService } from './users.service';
import { QueryCustomersDto } from './dto/query-users.dto';

describe('customer spending visibility', () => {
  const customers = [
    { id: 'paid', role: Role.CLIENT },
    { id: 'new', role: Role.CLIENT },
  ];
  const service = new UsersService(
    {
      user: {
        findMany: jest.fn().mockResolvedValue(customers),
        count: jest.fn().mockResolvedValue(customers.length),
      },
      order: {
        groupBy: jest.fn().mockResolvedValue([
          {
            customerId: 'paid',
            _sum: { total: new Prisma.Decimal(14500) },
            _count: { _all: 2 },
            _min: { createdAt: null },
            _max: { createdAt: null },
          },
        ]),
      },
    } as never,
    {} as never,
  );

  it.each(['newest', 'spend'] as const)(
    'withholds spending for sales staff in the %s directory',
    async (sort) => {
      const query = Object.assign(new QueryCustomersDto(), { sort });
      const result = await service.listCustomers(query, Role.SALES_PERSON);
      for (const customer of result.items) expect(customer.lifetimeSpend).toBeUndefined();
      // Undefined fields are omitted from the actual JSON API response.
      expect(JSON.stringify(result)).not.toContain('lifetimeSpend');
    },
  );

  it.each([Role.ADMIN, Role.STOCK_MANAGER, Role.DATA_ANALYST])(
    'returns real spending and zero for %s',
    async (role) => {
      for (const sort of ['newest', 'spend'] as const) {
        const query = Object.assign(new QueryCustomersDto(), { sort });
        const result = await service.listCustomers(query, role);
        expect(result.items.find((customer) => customer.id === 'paid')?.lifetimeSpend).toBe(14500);
        expect(result.items.find((customer) => customer.id === 'new')?.lifetimeSpend).toBe(0);
      }
    },
  );
});

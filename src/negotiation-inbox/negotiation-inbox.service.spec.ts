/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.any(...)` matchers are typed `any` */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderMessageAuthor, Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor } from '@/common/utils/cursor';
import { NegotiationInboxService } from './negotiation-inbox.service';

describe('NegotiationInboxService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let service: NegotiationInboxService;

  const row = (n: number, overrides: Record<string, unknown> = {}) => ({
    kind: 'order',
    id: `order-${n}`,
    last_at: new Date(Date.UTC(2026, 8, 18, 12, 0, 60 - n)),
    message_count: 3,
    order_number: `ORD-${n}`,
    customer_id: `customer-${n}`,
    full_name: `Customer ${n}`,
    email: `c${n}@example.com`,
    msg_id: `msg-${n}`,
    msg_author: 'CUSTOMER',
    msg_sender: `customer-${n}`,
    msg_body: `hello ${n}`,
    ...overrides,
  });

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() };
    service = new NegotiationInboxService(prisma as never);
  });

  /** The `Prisma.Sql` object the service handed to `$queryRaw`. */
  const issued = () => (prisma.$queryRaw.mock.calls as [Prisma.Sql][])[0][0];

  it('answers a whole page with a single database query', async () => {
    prisma.$queryRaw.mockResolvedValue([row(1), row(2), row(3)]);

    const page = await service.list({ limit: 25 });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(3);
  });

  it('shapes each row for the list: customer, latest message, count, awaiting-reply', async () => {
    prisma.$queryRaw.mockResolvedValue([
      row(1),
      row(2, { kind: 'cart', order_number: null, msg_author: 'STAFF', msg_sender: 'staff-1' }),
      row(3, { msg_author: 'SYSTEM', msg_sender: null }),
    ]);

    const { items } = await service.list({});

    expect(items[0]).toEqual({
      kind: 'order',
      id: 'order-1',
      orderNumber: 'ORD-1',
      customer: { id: 'customer-1', fullName: 'Customer 1', email: 'c1@example.com' },
      messageCount: 3,
      lastMessageAt: expect.any(Date),
      lastMessage: {
        id: 'msg-1',
        author: OrderMessageAuthor.CUSTOMER,
        senderId: 'customer-1',
        body: 'hello 1',
        createdAt: expect.any(Date),
      },
      awaitingReply: true,
    });
    expect(items[1]).toMatchObject({ kind: 'cart', orderNumber: null, awaitingReply: false });
    expect(items[2].awaitingReply).toBe(true);
  });

  it('asks for one row beyond the page and hands back a cursor only when there is more', async () => {
    prisma.$queryRaw.mockResolvedValue([row(1), row(2), row(3)]);

    const page = await service.list({ limit: 2 });

    expect(issued().values).toContain(3);
    expect(page.items).toHaveLength(2);
    const cursor = decodeCursor(page.nextCursor!);
    expect(cursor.id).toBe('order-2');
    expect(cursor.at.getTime()).toBe(page.items[1].lastMessageAt.getTime());
  });

  it('has no next cursor on the last page', async () => {
    prisma.$queryRaw.mockResolvedValue([row(1)]);
    await expect(service.list({ limit: 2 })).resolves.toMatchObject({ nextCursor: null });
  });

  it("resumes after the cursor's (last activity, id) position, bound as parameters", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const at = new Date('2026-09-18T10:00:00.000Z');

    await service.list({ limit: 5, cursor: encodeCursor(at, 'order-9') });

    expect(issued().sql).toContain('(t.last_at, t.id) < (');
    expect(issued().values).toEqual(expect.arrayContaining([at, 'order-9']));
  });

  it('searches customer name, email and order number in the database — with LIKE wildcards escaped', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.list({ search: ' 50%_off! ' });

    expect(issued().sql).toContain(`ILIKE`);
    expect(issued().sql).toContain(`ESCAPE '!'`);
    expect(issued().values).toContain('%50!%!_off!!%');
  });

  it('adds no filters for a blank search or first page', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await service.list({ search: '   ' });
    expect(issued().sql).not.toContain('ILIKE');
    expect(issued().sql).not.toContain('t.last_at, t.id) <');
  });

  it('never interpolates user input into the SQL text', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const hostile = 'x\'; DROP TABLE "User"; --';

    await service.list({ search: hostile, cursor: encodeCursor(new Date(), "id'); --") });

    expect(issued().sql).not.toContain('DROP TABLE');
    expect(issued().sql).not.toContain("id'); --");
  });

  it('previews the last-inserted message when several share a timestamp', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await service.list({});
    expect(issued().sql).toContain('ORDER BY m."createdAt" DESC, m.ctid DESC');
    expect(issued().sql).not.toContain('m."id" DESC');
  });

  it('rejects a malformed cursor with a 400 before querying', async () => {
    await expect(service.list({ cursor: 'garbage' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  describe('summary', () => {
    it("returns one thread's row", async () => {
      prisma.$queryRaw.mockResolvedValue([
        row(4, { kind: 'cart', id: 'cart-4', order_number: null }),
      ]);

      const thread = await service.summary('cart', 'cart-4');

      expect(thread).toMatchObject({ kind: 'cart', id: 'cart-4' });
      expect(issued().values).toEqual(expect.arrayContaining(['cart', 'cart-4']));
    });

    it('is a 404 for a thread with no messages or that does not exist', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.summary('order', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

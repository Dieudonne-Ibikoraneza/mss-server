import { BadRequestException } from '@nestjs/common';
import { encodeCursor } from '@/common/utils/cursor';
import { RoomsService } from './rooms.service';

describe('RoomsService.findSharedDesigns — pagination + search', () => {
  let prisma: { roomDesign: { findMany: jest.Mock } };
  let products: { serializeEmbedded: jest.Mock };
  let service: RoomsService;

  const design = (n: number) => ({
    id: `design-${String(n).padStart(2, '0')}`,
    createdAt: new Date(Date.UTC(2026, 8, 18, 12, 0, 60 - n)),
    tiles: [{ id: `t${n}`, product: { id: `p${n}` } }],
  });
  const rows = (count: number) => Array.from({ length: count }, (_, i) => design(i + 1));

  beforeEach(() => {
    prisma = { roomDesign: { findMany: jest.fn() } };
    products = {
      serializeEmbedded: jest.fn((list: unknown[]) =>
        Promise.resolve(list.map((p) => ({ ...(p as object), signed: true }))),
      ),
    };
    service = new RoomsService(prisma as never, {} as never, products as never, {} as never);
  });

  const call = () => {
    const [args] = prisma.roomDesign.findMany.mock.calls[0] as [
      { where: { AND: Record<string, unknown>[] }; take: number; orderBy: unknown },
    ];
    return args;
  };

  it('asks the database for one extra row, and only ever returns a page', async () => {
    prisma.roomDesign.findMany.mockResolvedValue(rows(13));

    const result = await service.findSharedDesigns({ limit: 12 });

    expect(call().take).toBe(13);
    expect(result.items).toHaveLength(12);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it('has no next cursor on the last page', async () => {
    prisma.roomDesign.findMany.mockResolvedValue(rows(5));

    const result = await service.findSharedDesigns({ limit: 12 });

    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it('defaults to a small page and always filters to shared designs, newest first', async () => {
    prisma.roomDesign.findMany.mockResolvedValue([]);

    await service.findSharedDesigns({});

    expect(call().take).toBe(13);
    expect(call().where.AND).toEqual([{ sharedWithSales: true }]);
    expect(call().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it("resumes strictly after the cursor's (createdAt, id) position", async () => {
    prisma.roomDesign.findMany.mockResolvedValue([]);
    const at = new Date('2026-09-18T10:00:00.000Z');

    await service.findSharedDesigns({ limit: 5, cursor: encodeCursor(at, 'design-07') });

    expect(call().where.AND[1]).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'design-07' } }],
    });
  });

  it('searches design name, room name, and the customer name/email — case-insensitively, in the database', async () => {
    prisma.roomDesign.findMany.mockResolvedValue([]);

    await service.findSharedDesigns({ search: '  kitchen ' });

    const contains = { contains: 'kitchen', mode: 'insensitive' };
    expect(call().where.AND[1]).toEqual({
      OR: [
        { name: contains },
        { room: { name: contains } },
        { room: { nameRw: contains } },
        { user: { fullName: contains } },
        { user: { email: contains } },
      ],
    });
  });

  it('treats a blank search as no search', async () => {
    prisma.roomDesign.findMany.mockResolvedValue([]);
    await service.findSharedDesigns({ search: '   ' });
    expect(call().where.AND).toEqual([{ sharedWithSales: true }]);
  });

  it('signs product images only for the returned page, not the look-ahead row', async () => {
    prisma.roomDesign.findMany.mockResolvedValue(rows(13));

    await service.findSharedDesigns({ limit: 12 });

    expect(products.serializeEmbedded).toHaveBeenCalledTimes(12);
  });

  it('rejects a malformed cursor with a 400 before touching the database', async () => {
    await expect(service.findSharedDesigns({ cursor: 'garbage' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.roomDesign.findMany).not.toHaveBeenCalled();
  });
});

import { BadRequestException, ParseEnumPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Language, Prisma, Role, RoomType } from '@prisma/client';
import { CartService } from './cart/cart.service';
import { ChatbotService } from './chatbot/chatbot.service';
import { CollectionsService } from './collections/collections.service';
import { ConfiguredIoAdapter } from './negotiations/configured-io.adapter';
import { QuotesService } from './quotes/quotes.service';

describe('collections: exact stock and cost stay staff-only', () => {
  const product = {
    id: 'p1',
    name: 'Tile',
    isActive: true,
    quantityOnHandSqm: 100,
    reservedAreaSqm: 8,
    averageCostPrice: 42,
    price: 100,
  };
  const build = (cached: unknown = null) => {
    const store = new Map<string, unknown>();
    const redis = {
      cacheGet: jest.fn((key: string) => Promise.resolve(store.get(key) ?? cached)),
      cacheSet: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      cacheDel: jest.fn(),
    };
    const prisma = {
      collection: {
        findUnique: jest.fn().mockResolvedValue({ id: 'c1', image: 'x', products: [product] }),
      },
    };
    const storage = {
      resolveImageUrl: jest.fn((i: string) => Promise.resolve(i)),
      getSignedUrl: jest.fn(),
    };
    const service = new CollectionsService(
      prisma as never,
      redis as never,
      storage as never,
      {} as never,
    );
    return { service, redis, prisma };
  };
  const sensitive = ['quantityOnHandSqm', 'reservedAreaSqm', 'averageCostPrice'];

  it.each([undefined, Role.CLIENT])('removes them for %s', async (role) => {
    const { service } = build();
    const result = (await service.findOne('c1', role)) as { products: Record<string, unknown>[] };
    for (const key of sensitive) expect(result.products[0]).not.toHaveProperty(key);
    expect(result.products[0].price).toBe(100);
  });

  it.each([Role.ADMIN, Role.STOCK_MANAGER])(
    'keeps them for %s — and never caches that view',
    async (role) => {
      const { service, redis } = build();
      const result = (await service.findOne('c1', role)) as { products: Record<string, unknown>[] };
      expect(result.products[0].quantityOnHandSqm).toBe(100);
      expect(redis.cacheSet).not.toHaveBeenCalled();
    },
  );

  it('caches only the customer-safe copy, so a staff view can never be served to the public from cache', async () => {
    const { service, redis } = build();
    await service.findOne('c1', undefined);
    const cached = (
      redis.cacheSet.mock.calls as [string, { products: Record<string, unknown>[] }][]
    )[0][1];
    for (const key of sensitive) expect(cached.products[0]).not.toHaveProperty(key);
    // ...and the key is versioned, so entries written before this fix (with full rows) are never read.
    expect((redis.cacheSet.mock.calls as unknown as [string][])[0][0]).toContain(':v2:');
  });

  it('staff always read fresh rows, even when a cached (customer-safe) copy exists', async () => {
    const { service, prisma } = build({ id: 'c1', products: [] });
    const result = (await service.findOne('c1', Role.ADMIN)) as { products: unknown[] };
    expect(prisma.collection.findUnique).toHaveBeenCalled();
    expect(result.products).toHaveLength(1);
  });
});

describe('quotes: an unknown or retired product is a 400, never a 500', () => {
  const build = (products: unknown[]) => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
      quoteRequest: { create: jest.fn() },
    };
    return {
      service: new QuotesService(prisma as never, { recordJourneyEvent: jest.fn() } as never),
      prisma,
    };
  };
  const dto = { items: [{ productId: 'p1', areaSqm: 5 }] } as never;

  it('unknown product', async () => {
    const { service, prisma } = build([]);
    await expect(service.create('u1', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.quoteRequest.create).not.toHaveBeenCalled();
  });

  it('inactive product, named in the message', async () => {
    const { service } = build([{ id: 'p1', name: 'Old Tile', isActive: false }]);
    await expect(service.create('u1', dto)).rejects.toThrow('"Old Tile" is no longer available');
  });
});

describe('cart: two first requests at once', () => {
  const clash = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['userId'] },
    });

  it('the request that loses the race to create the cart retries and succeeds instead of failing with a 500', async () => {
    const upsert = jest.fn().mockRejectedValueOnce(clash()).mockResolvedValueOnce({ id: 'cart-1' });
    const prisma = {
      cart: { upsert },
      cartItem: { findMany: jest.fn().mockResolvedValue([]) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new CartService(prisma as never, {} as never);
    await expect(service.view('u1')).resolves.toMatchObject({ cartId: 'cart-1' });
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('does not swallow other errors', async () => {
    const prisma = { cart: { upsert: jest.fn().mockRejectedValue(new Error('database down')) } };
    const service = new CartService(prisma as never, {} as never);
    await expect(service.view('u1')).rejects.toThrow('database down');
  });
});

describe('the profiling-question filters', () => {
  it.each([
    ['language', Language],
    ['roomType', RoomType],
  ] as const)(
    '%s must be a real value — anything else is a 400, not a database error',
    async (_name, enumType) => {
      const pipe = new ParseEnumPipe(enumType, { optional: true }) as unknown as {
        transform: (value: unknown, metadata: unknown) => Promise<unknown>;
      };
      const meta = { type: 'query', metatype: String, data: 'x' };
      await expect(pipe.transform('ZZ', meta)).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform(undefined, meta)).resolves.toBeUndefined();
      await expect(pipe.transform(Object.values(enumType)[0], meta)).resolves.toBeDefined();
    },
  );
});

describe('the chatbot is shown the NEWEST 20 turns', () => {
  it('asks for the newest first and hands them over oldest-first', async () => {
    const newestFirst = [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }];
    const findMany = jest.fn().mockResolvedValue(newestFirst);
    const service = Object.create(ChatbotService.prototype) as ChatbotService;
    (service as unknown as { prisma: unknown }).prisma = { chatMessage: { findMany } };

    const history = await service.recentMessages('conv-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(history.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('the negotiations socket uses the configured origins', () => {
  it('builds its server with the same allowed origins as the HTTP API, with credentials', () => {
    const create = jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue({});
    const adapter = new ConfiguredIoAdapter({} as never, [
      'https://app.example',
      'https://admin.example',
    ]);

    adapter.createIOServer(3000, { path: '/socket.io' } as never);

    expect(create).toHaveBeenCalledWith(
      3000,
      expect.objectContaining({
        path: '/socket.io',
        cors: { origin: ['https://app.example', 'https://admin.example'], credentials: true },
      }),
    );
    create.mockRestore();
  });
});

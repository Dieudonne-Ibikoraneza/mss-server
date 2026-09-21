import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FavoritesService } from './favorites/favorites.service';
import { QuotesService } from './quotes/quotes.service';
import { RoomsService } from './rooms/rooms.service';
import { AuthService } from './auth/auth.service';
import { ChatbotService } from './chatbot/chatbot.service';
import { CompareProductsDto } from './chatbot/dto/compare-products.dto';
import { downloadReferenceImage } from './chatbot/providers/gemini-image-client';
import { assertPublicHttpUrl, isPrivateAddress } from './common/utils/safe-url';
import { invalidateProductsCache } from './products/products-cache.util';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('public compare: input limits', () => {
  const check = (productIds: string[], sessionId = 's') =>
    validate(plainToInstance(CompareProductsDto, { productIds, sessionId }));

  it('accepts 2–4 distinct products', async () => {
    expect(await check([uuid(1), uuid(2)])).toHaveLength(0);
    expect(await check([uuid(1), uuid(2), uuid(3), uuid(4)])).toHaveLength(0);
  });
  it('rejects a huge array, duplicates and an oversized session id', async () => {
    expect((await check(Array.from({ length: 50 }, (_, i) => uuid(i)))).length).toBeGreaterThan(0);
    expect((await check([uuid(1), uuid(1)])).length).toBeGreaterThan(0);
    expect((await check([uuid(1), uuid(2)], 'x'.repeat(5000))).length).toBeGreaterThan(0);
  });
});

describe('refresh tokens: a single winner', () => {
  const build = (claimed: number) => {
    const prisma = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          userId: 'u1',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', role: 'CLIENT', status: 'ACTIVE' }),
      },
    };
    const service = Object.create(AuthService.prototype) as AuthService;
    Object.assign(service, {
      prisma,
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a' }),
    });
    return { service, prisma };
  };

  it('spends the token with a conditional update, and the loser gets no tokens', async () => {
    const win = build(1);
    await expect(win.service.refresh('tok')).resolves.toEqual({ accessToken: 'a' });
    expect(win.prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1', revokedAt: null } }),
    );
    const lose = build(0);
    await expect(lose.service.refresh('tok')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('server-side fetches never go to internal addresses', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // how Node writes ::ffff:127.0.0.1
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '::ffff:c0a8:101', // 192.168.1.1
    '::7f00:1', // IPv4-compatible
    '64:ff9b::7f00:1', // NAT64
    '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
    '0:0:0:0:0:0:0:1',
    '::ffff:0:0',
    'not-an-ip',
  ])('%s is private', (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808'])(
    '%s is public',
    (address) => expect(isPrivateAddress(address)).toBe(false),
  );

  it.each([
    'http://127.0.0.1/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://[::ffff:7f00:1]/x.png',
    'http://localhost/x.png',
    'file:///etc/passwd',
    'ftp://example.com/x.png',
    'http://user:pass@8.8.8.8/x.png',
    'not a url',
  ])('%s is refused', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  it('the image downloader returns nothing for an internal address instead of fetching it', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    await expect(
      downloadReferenceImage('http://169.254.169.254/latest/meta-data/'),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('room photos belong to the customer who uploaded them', () => {
  const service = Object.create(ChatbotService.prototype) as ChatbotService;
  Object.assign(service, {
    prisma: {
      chatConversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', userId: 'me' }) },
    },
  });
  const preview = (roomImagePath: string) =>
    service.generateImagePreview({ conversationId: 'c1', roomImagePath, productId: uuid(1) }, 'me');

  it.each([
    'rooms/someone-else/photo.png',
    'rooms/photo.png', // an old-style path names no owner
    'rooms/me/../someone-else/photo.png',
    'other-bucket/me/photo.png',
  ])('refuses %s before touching storage', async (path) => {
    await expect(preview(path)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('after-commit cache clean-up cannot fail the request', () => {
  it('a Redis outage is swallowed', async () => {
    const redis = { delByPrefix: jest.fn().mockRejectedValue(new Error('redis down')) };
    await expect(invalidateProductsCache(redis as never, ['p1'])).resolves.toBeUndefined();
    expect(redis.delByPrefix).toHaveBeenCalled();
  });
});

describe('saved work is never lost to a failing analytics call, and hidden records cannot be used', () => {
  const failing = () => jest.fn().mockRejectedValue(new Error('analytics down'));

  describe('favorites', () => {
    const build = (over: { product?: unknown; createError?: unknown } = {}) => {
      const prisma = {
        product: {
          findUnique: jest
            .fn()
            .mockResolvedValue('product' in over ? over.product : { id: 'p1', isActive: true }),
        },
        favorite: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: over.createError
            ? jest.fn().mockRejectedValue(over.createError)
            : jest.fn().mockResolvedValue({ id: 'f1' }),
        },
      };
      const events = { recordTileEvent: failing() };
      return {
        service: new FavoritesService(prisma as never, events as never, {} as never),
        prisma,
      };
    };

    it('an inactive product cannot be saved', async () => {
      const { service, prisma } = build({ product: { id: 'p1', isActive: false } });
      await expect(service.add('u1', 'p1', 's')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.favorite.create).not.toHaveBeenCalled();
    });

    it('the favorite is returned even though the analytics event failed', async () => {
      await expect(build().service.add('u1', 'p1', 's')).resolves.toEqual({ id: 'f1' });
    });

    it('two saves at once: the loser gets "already saved", not a server error', async () => {
      const clash = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      });
      await expect(
        build({ createError: clash }).service.add('u1', 'p1', 's'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('saved designs', () => {
    const dto = {
      roomId: 'r1',
      name: 'D',
      tiles: [{ surface: 'FLOOR', productId: 'p1' }],
    } as never;
    const build = (room: unknown, product: unknown) => {
      const prisma = {
        room: { findUnique: jest.fn().mockResolvedValue(room) },
        product: { findMany: jest.fn().mockResolvedValue(product ? [product] : []) },
        roomDesign: { create: jest.fn().mockResolvedValue({ id: 'd1', tiles: [] }) },
      };
      const events = { recordTileEvent: failing(), recordJourneyEvent: failing() };
      const service = new RoomsService(prisma as never, events as never, {} as never, {} as never);
      (service as unknown as { withSerializedTiles: (d: unknown) => unknown }).withSerializedTiles =
        (design) => design;
      return { service, prisma };
    };
    const tile = { id: 'p1', name: 'T', suitableFor: 'BOTH', isActive: true };

    it('a hidden room is refused', async () => {
      const { service, prisma } = build({ id: 'r1', isActive: false }, tile);
      await expect(service.saveDesign('u1', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.roomDesign.create).not.toHaveBeenCalled();
    });

    it('an inactive product is refused', async () => {
      const { service } = build({ id: 'r1', isActive: true }, { ...tile, isActive: false });
      await expect(service.saveDesign('u1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('the design is returned even though the analytics events failed', async () => {
      const { service } = build({ id: 'r1', isActive: true }, tile);
      await expect(service.saveDesign('u1', dto)).resolves.toMatchObject({ id: 'd1' });
    });
  });

  it('a quotation request is returned even though the analytics event failed', async () => {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p1',
            name: 'T',
            isActive: true,
            price: 100,
            boxCoverageSqm: 1,
            piecesPerBox: 4,
            collection: { tileAreaSqm: 0.25 },
          },
        ]),
      },
      quoteRequest: { create: jest.fn().mockResolvedValue({ id: 'q1' }) },
    };
    const service = new QuotesService(prisma as never, { recordJourneyEvent: failing() } as never);
    await expect(
      service.create('u1', { items: [{ productId: 'p1', areaSqm: 5 }] }),
    ).resolves.toEqual({ id: 'q1' });
  });

  describe('quote status updates', () => {
    const build = (updateError?: Error) => {
      const prisma = {
        quoteRequest: {
          findUnique: jest.fn().mockResolvedValue({ id: 'q1', userId: 'u1' }),
          update: updateError
            ? jest.fn().mockRejectedValue(updateError)
            : jest.fn().mockResolvedValue({ id: 'q1', status: 'NEGOTIATING' }),
        },
      };
      const events = { recordJourneyEvent: failing() };
      return { service: new QuotesService(prisma as never, events as never), prisma, events };
    };
    const staffUser = { id: 's1', role: 'SALES_PERSON' } as never;

    it('the status change is returned even though the analytics event failed', async () => {
      const { service, events } = build();
      await expect(
        service.updateStatus('q1', { status: 'NEGOTIATING' } as never, staffUser),
      ).resolves.toMatchObject({ status: 'NEGOTIATING' });
      expect(events.recordJourneyEvent).toHaveBeenCalled();
    });

    it('nothing is recorded when the update itself fails', async () => {
      const { service, events } = build(new Error('db down'));
      await expect(
        service.updateStatus('q1', { status: 'NEGOTIATING' } as never, staffUser),
      ).rejects.toThrow('db down');
      expect(events.recordJourneyEvent).not.toHaveBeenCalled();
    });
  });
});

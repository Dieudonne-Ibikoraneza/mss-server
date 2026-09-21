import { Role } from '@prisma/client';
import Redis from 'ioredis';
import { ChatbotService } from '../../src/chatbot/chatbot.service';
import { EventsService } from '../../src/events/events.service';
import { RedisService } from '../../src/redis/redis.service';
import { createActors, createProduct, outcome, prisma, type Actors } from './harness';

describe('public endpoints and multi-pick feedback (real database and Redis)', () => {
  const redisClient = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const events = new EventsService(prisma as never, new RedisService(redisClient));
  let actors: Actors;

  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(async () => {
    redisClient.disconnect();
    await prisma.$disconnect();
  });

  describe('compared events', () => {
    const compared = (productId: string) =>
      prisma.tileEvent.count({ where: { productId, type: 'COMPARED' } });

    it('the same comparison repeated is counted once; another visitor counts separately', async () => {
      const [a, b] = [
        await createProduct(actors, { onHand: 5 }),
        await createProduct(actors, { onHand: 5 }),
      ];
      const visitor = `sess-${Date.now().toString(36)}`;
      const compare = (sessionId: string, role?: Role) =>
        events.recordPublicComparison({ sessionId, role, productIds: [a.id, b.id] });

      await Promise.all(Array.from({ length: 10 }, () => compare(visitor)));
      await compare(visitor);
      expect(await compared(a.id)).toBe(1);
      expect(await compared(b.id)).toBe(1);

      await compare(`${visitor}-other`);
      expect(await compared(a.id)).toBe(2);
    });

    it('staff comparing products are not customers and are not counted', async () => {
      const [a, b] = [
        await createProduct(actors, { onHand: 5 }),
        await createProduct(actors, { onHand: 5 }),
      ];
      await events.recordPublicComparison({
        userId: actors.staff.id,
        role: Role.STOCK_MANAGER,
        sessionId: 'staff-session',
        productIds: [a.id, b.id],
      });
      expect(await compared(a.id)).toBe(0);
    });
  });

  describe('feedback on a multi-pick card', () => {
    const chatbot = Object.create(ChatbotService.prototype) as ChatbotService;
    (chatbot as unknown as { prisma: unknown }).prisma = prisma;

    const recommend = (userId: string, productId: string, rank: number) =>
      prisma.recommendation.create({
        data: { userId, sessionId: 's', productId, rank, matchScore: 80 },
      });
    const decisions = async (ids: string[]) =>
      (await prisma.recommendation.findMany({ where: { id: { in: ids } } })).map(
        (row) => row.decision,
      );

    it('saves every pick of the card together', async () => {
      const [floor, wall] = [
        await createProduct(actors, { onHand: 5 }),
        await createProduct(actors, { onHand: 5 }),
      ];
      const ids = [
        (await recommend(actors.customer.id, floor.id, 1)).id,
        (await recommend(actors.customer.id, wall.id, 2)).id,
      ];
      await chatbot.setRecommendationDecisions(ids, 'ACCEPTED', actors.customer.id);
      expect(await decisions(ids)).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    it("if any pick is not the caller's, none is changed", async () => {
      const product = await createProduct(actors, { onHand: 5 });
      const mine = await recommend(actors.customer.id, product.id, 1);
      const theirs = await recommend(actors.staff.id, product.id, 2);
      const result = await outcome(() =>
        chatbot.setRecommendationDecisions([mine.id, theirs.id], 'REJECTED', actors.customer.id),
      );
      expect(result).toBe('NotFoundException');
      expect(await decisions([mine.id, theirs.id])).toEqual(['PENDING', 'PENDING']);
    });
  });
});

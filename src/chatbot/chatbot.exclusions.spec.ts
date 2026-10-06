import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Language, Prisma, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { StorageService } from '@/storage/storage.service';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { ChatProvider } from './providers/chat-provider.interface';
import { RecommendationImageProvider } from './providers/recommendation-image.provider';
import { RoomTileEditProvider } from './providers/room-tile-provider.interface';
import {
  ListRecommendationTilesDto,
  RecommendationEligibility,
  UpdateRecommendationExclusionDto,
} from './dto/recommendation-exclusion.dto';

type Candidate = Prisma.ProductGetPayload<{ include: { collection: true } }>;
const tile = (id: string) =>
  ({
    id,
    name: id,
    sku: id,
    image: `https://example.com/${id}.png`,
    price: 5000,
    currency: 'RWF',
    quantityOnHandSqm: 100,
    reservedAreaSqm: 0,
    recommendationExcluded: false,
    isActive: true,
    suitableFor: id === 'floor' ? 'FLOOR' : 'WALL',
    visualizerPattern: id === 'floor' ? 'TWO_TURN' : 'STRAIGHT',
    visualizerPatternCorner: 'TOP_RIGHT',
    collection: { title: 'Tiles', size: '60×60cm', tileAreaSqm: 0.36 },
  }) as unknown as Candidate;

describe('chatbot recommendation exclusions', () => {
  const floor = tile('floor');
  const wall = tile('wall');
  const pick = { productId: floor.id, wallProductId: wall.id, matchScore: 90, reason: 'Fits' };
  let service: ChatbotService;
  let prisma: {
    product: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    recommendation: {
      create: jest.Mock<
        Promise<{ id: string }>,
        [{ data: Prisma.RecommendationUncheckedCreateInput }]
      >;
      count: jest.Mock;
    };
    chatConversation: { findFirst: jest.Mock };
    chatMessage: { create: jest.Mock; findMany: jest.Mock };
    knowledgeBaseEntry: { findMany: jest.Mock };
    platformSetting: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let provider: { reply: jest.MockedFunction<ChatProvider['reply']> };
  let images: { generate: jest.MockedFunction<RecommendationImageProvider['generate']> };

  beforeEach(() => {
    prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([floor, wall]),
        findUnique: jest.fn().mockResolvedValue({ id: floor.id }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(2),
      },
      recommendation: {
        create: jest
          .fn<Promise<{ id: string }>, [{ data: Prisma.RecommendationUncheckedCreateInput }]>()
          .mockResolvedValue({ id: 'recommendation' }),
        count: jest.fn().mockResolvedValue(0),
      },
      chatConversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation',
          title: 'Room',
          userId: 'user',
          sessionId: 'session',
          language: Language.EN,
        }),
      },
      chatMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      knowledgeBaseEntry: { findMany: jest.fn().mockResolvedValue([]) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest
        .fn()
        .mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    provider = { reply: jest.fn().mockResolvedValue({ reply: 'Here are your tiles.', picks: [] }) };
    images = { generate: jest.fn().mockResolvedValue(null) };
    service = new ChatbotService(
      prisma as unknown as PrismaService,
      {} as EventsService,
      provider,
      images,
      {} as RoomTileEditProvider,
      {
        resolveImageUrl: jest.fn().mockImplementation((image: string) => Promise.resolve(image)),
      } as unknown as StorageService,
    );
  });

  const persist = (picks = [pick]) =>
    service['persistAndResolveRecommendations'](
      picks,
      [floor, wall],
      'user',
      'session',
      'message',
      'Kitchen',
      'KITCHEN',
    );

  it('filters excluded tiles before sending candidates to the AI provider', async () => {
    prisma.product.findMany.mockResolvedValue([floor]);
    await service.sendMessage(
      { sessionId: 'session', content: 'Recommend tiles for my kitchen' },
      'user',
      Role.CLIENT,
    );
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, recommendationExcluded: false },
      }),
    );
    expect(
      provider.reply.mock.calls[0][0].candidates.map((candidate: { id: string }) => candidate.id),
    ).toEqual(['floor']);
  });

  it('does not save or generate an excluded floor pick even if the AI returns it', async () => {
    prisma.product.findMany.mockResolvedValue([{ id: wall.id }]);
    expect(await persist()).toEqual([]);
    expect(images.generate).not.toHaveBeenCalled();
    expect(prisma.recommendation.create).not.toHaveBeenCalled();
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['floor', 'wall'] }, isActive: true, recommendationExcluded: false },
      }),
    );
  });

  it('omits an excluded wall tile while preserving the allowed floor recommendation', async () => {
    prisma.product.findMany.mockResolvedValue([{ id: floor.id }]);
    const cards = await persist();
    expect(cards).toHaveLength(1);
    expect(cards[0].wallProduct).toBeUndefined();
    expect(images.generate.mock.calls[0][0].wallProduct).toBeUndefined();
    expect(prisma.recommendation.create).toHaveBeenCalledTimes(1);
    expect(prisma.recommendation.create.mock.calls[0][0].data.productId).toBe(floor.id);
  });

  it('still saves both surfaces when both tiles are allowed', async () => {
    const cards = await persist();
    expect(cards[0].wallProduct?.id).toBe(wall.id);
    expect(prisma.recommendation.create).toHaveBeenCalledTimes(2);
  });

  it('passes both tiles physical scale and saved layout through to image generation', async () => {
    await persist();
    const input = images.generate.mock.calls[0][0];
    expect(input.product).toMatchObject({
      size: '60×60cm',
      tileAreaSqm: 0.36,
      suitableFor: 'FLOOR',
      visualizerPattern: 'TWO_TURN',
      visualizerPatternCorner: 'TOP_RIGHT',
    });
    expect(input.wallProduct).toMatchObject({
      size: '60×60cm',
      tileAreaSqm: 0.36,
      suitableFor: 'WALL',
      visualizerPattern: 'STRAIGHT',
      visualizerPatternCorner: 'TOP_RIGHT',
    });
  });

  it.each([true, false])(
    'persists exclusion=%s without changing catalog activation',
    async (excluded) => {
      expect(await service.updateRecommendationExclusion(floor.id, excluded)).toEqual({
        id: floor.id,
        recommendationExcluded: excluded,
      });
      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: floor.id, ...(!excluded ? { isActive: true } : {}) },
        data: { recommendationExcluded: excluded },
      });
    },
  );

  it('rejects changes to a missing tile', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.updateRecommendationExclusion('missing', true)).rejects.toThrow();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('rejects allowing an inactive tile, including concurrent deactivation', async () => {
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateRecommendationExclusion(floor.id, false)).rejects.toThrow(
      'Reactivate this tile in the catalog before allowing recommendations.',
    );
    expect(prisma.product.updateMany).toHaveBeenCalledWith({
      where: { id: floor.id, isActive: true },
      data: { recommendationExcluded: false },
    });
  });

  it('searches names and SKU within the excluded list with pagination', async () => {
    const dto = plainToInstance(ListRecommendationTilesDto, {
      search: '  marble ',
      eligibility: RecommendationEligibility.EXCLUDED,
      page: 2,
      limit: 10,
    });
    const result = await service.listRecommendationTiles(dto);
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          recommendationExcluded: true,
          OR: ['name', 'nameRw', 'sku'].map((field) => ({
            [field]: { contains: 'marble', mode: 'insensitive' },
          })),
        },
        skip: 10,
        take: 10,
      }),
    );
    expect(result.meta).toEqual({ page: 2, limit: 10, total: 2, totalPages: 1 });
  });

  it('only shows active, non-excluded tiles in the allowed filter', async () => {
    const dto = plainToInstance(ListRecommendationTilesDto, {
      eligibility: RecommendationEligibility.ELIGIBLE,
    });
    await service.listRecommendationTiles(dto);
    const where = { recommendationExcluded: false, isActive: true };
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.product.count).toHaveBeenCalledWith({ where });
  });

  it('requires a real boolean for exclusion updates', async () => {
    for (const body of [
      {},
      { recommendationExcluded: 'false' },
      { recommendationExcluded: null },
    ]) {
      expect(
        await validate(plainToInstance(UpdateRecommendationExclusionDto, body)),
      ).not.toHaveLength(0);
    }
    expect(
      await validate(
        plainToInstance(UpdateRecommendationExclusionDto, { recommendationExcluded: false }),
      ),
    ).toHaveLength(0);
  });

  it('restricts both management endpoints to admins', () => {
    for (const method of ['listRecommendationTiles', 'updateRecommendationExclusion'] as const) {
      const handler = Object.getOwnPropertyDescriptor(ChatbotController.prototype, method)!
        .value as object;
      expect(Reflect.getMetadata('roles', handler)).toEqual([Role.ADMIN]);
    }
  });
});

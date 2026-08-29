import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ChatRole, Language, Prisma, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { canSeeExactStock, getLowStockThreshold, stockStatusOf } from '@/common/utils/stock-status';
import {
  CHAT_PROVIDER,
  type ChatProductCandidate,
  type ChatProvider,
} from './providers/chat-provider.interface';
import {
  StubImagePreviewProvider,
  StubVideoPreviewProvider,
} from './providers/stub-media.provider';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto, VideoPreviewDto } from './dto/media-preview.dto';
import { UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';

/** How many active products to ground the assistant with — enough choice without bloating the prompt. */
const MAX_CANDIDATE_PRODUCTS = 40;

@Injectable()
export class ChatbotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(CHAT_PROVIDER) private readonly chatProvider: ChatProvider,
    private readonly imageProvider: StubImagePreviewProvider,
    private readonly videoProvider: StubVideoPreviewProvider,
  ) {}

  private async getOrCreateConversation(
    sessionId: string,
    userId: string | undefined,
    language: Language,
  ) {
    if (userId) {
      const existing = await this.prisma.chatConversation.findFirst({
        where: { userId, sessionId },
      });
      if (existing) return existing;
    }
    return this.prisma.chatConversation.create({ data: { userId, sessionId, language } });
  }

  async sendMessage(dto: SendMessageDto, userId?: string) {
    const conversation = dto.conversationId
      ? await this.prisma.chatConversation.findUnique({ where: { id: dto.conversationId } })
      : await this.getOrCreateConversation(dto.sessionId, userId, dto.language ?? Language.EN);
    if (!conversation) throw new NotFoundException('Conversation not found.');

    await this.prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: ChatRole.USER, content: dto.content },
    });

    const [history, knowledgeBase, candidateProducts, lowStockThreshold] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
      this.prisma.knowledgeBaseEntry.findMany({
        where: { isActive: true, language: conversation.language },
        take: 10,
      }),
      this.prisma.product.findMany({
        where: { isActive: true },
        include: { collection: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_CANDIDATE_PRODUCTS,
      }),
      getLowStockThreshold(this.prisma),
    ]);

    const candidates: ChatProductCandidate[] = candidateProducts.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      size: product.collection.size,
      suitableFor: product.suitableFor,
      roomTypes: product.roomTypes,
      price: Number(product.price),
      currency: product.currency,
      stockStatus: stockStatusOf(Number(product.quantityOnHandSqm), lowStockThreshold),
    }));

    const { reply, picks } = await this.chatProvider.reply({
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      language: conversation.language,
      candidates,
      knowledgeBase: knowledgeBase.map((entry) => ({
        question: entry.question,
        answer: entry.answer,
      })),
    });

    const assistantMessage = await this.prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: ChatRole.ASSISTANT, content: reply },
    });

    const products = await this.persistAndResolveRecommendations(
      picks,
      candidateProducts,
      conversation.userId ?? userId,
      dto.sessionId,
    );

    return { conversation, message: assistantMessage, products };
  }

  /**
   * Every pick was already validated against this turn's candidate ids by the provider,
   * but we resolve against the DB again here rather than trusting the provider's echoed
   * name/price/image — those must always come from Postgres, never from the model.
   */
  private async persistAndResolveRecommendations(
    picks: { productId: string; matchScore: number; reason: string }[],
    candidateProducts: Prisma.ProductGetPayload<{
      include: { collection: true };
    }>[],
    userId: string | undefined,
    sessionId: string,
  ) {
    if (picks.length === 0) return [];

    const byId = new Map(candidateProducts.map((p) => [p.id, p]));
    const resolved = picks
      .map((pick, index) => {
        const product = byId.get(pick.productId);
        return product ? { pick, product, rank: index + 1 } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (resolved.length === 0) return [];

    await this.prisma.recommendation.createMany({
      data: resolved.map(({ pick, product, rank }) => ({
        userId,
        sessionId,
        productId: product.id,
        rank,
        matchScore: pick.matchScore,
        reason: pick.reason,
      })),
    });

    return resolved.map(({ product }) => ({
      id: product.id,
      name: product.name,
      image: product.image,
      price: Number(product.price),
      link: `/products/${product.id}`,
    }));
  }

  getHistory(conversationId: string) {
    return this.prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async compareProducts(dto: CompareProductsDto, userId?: string, viewerRole?: Role) {
    const [rows, lowStockThreshold] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: dto.productIds } } }),
      getLowStockThreshold(this.prisma),
    ]);
    if (rows.length !== dto.productIds.length) {
      throw new NotFoundException('One or more products could not be found.');
    }

    // This endpoint is public (anonymous visitors can compare products), so
    // exact stock/cost — staff-only everywhere else — must be stripped here too.
    const products = rows.map(({ quantityOnHandSqm, averageCostPrice, ...rest }) => ({
      ...rest,
      stockStatus: stockStatusOf(Number(quantityOnHandSqm), lowStockThreshold),
      ...(canSeeExactStock(viewerRole)
        ? {
            quantityOnHandSqm: Number(quantityOnHandSqm),
            averageCostPrice: Number(averageCostPrice),
          }
        : {}),
    }));

    await Promise.all(
      dto.productIds.map((productId) =>
        this.events.recordTileEvent({
          userId,
          sessionId: dto.sessionId,
          productId,
          type: 'COMPARED',
          metadata: { comparedWith: dto.productIds.filter((id) => id !== productId) },
        }),
      ),
    );

    return { products };
  }

  async generateImagePreview(dto: ImagePreviewDto) {
    const job = await this.prisma.chatMediaJob.create({
      data: {
        conversationId: dto.conversationId,
        type: 'IMAGE_PREVIEW',
        status: 'PROCESSING',
        inputUrl: dto.roomImageUrl,
      },
    });

    const result = await this.imageProvider.generate({
      roomImageUrl: dto.roomImageUrl,
      productIds: dto.productIds,
    });

    return this.prisma.chatMediaJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', outputUrl: result.outputUrl },
    });
  }

  async generateVideoPreview(dto: VideoPreviewDto) {
    const job = await this.prisma.chatMediaJob.create({
      data: {
        conversationId: dto.conversationId,
        type: 'VIDEO_PREVIEW',
        status: 'PROCESSING',
        inputUrl: dto.roomVideoUrl,
      },
    });

    const result = await this.videoProvider.generate({
      roomVideoUrl: dto.roomVideoUrl,
      productIds: dto.productIds,
    });

    return this.prisma.chatMediaJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', outputUrl: result.outputUrl },
    });
  }

  listKnowledgeBase() {
    return this.prisma.knowledgeBaseEntry.findMany({ where: { isActive: true } });
  }

  createKnowledgeBaseEntry(dto: UpsertKnowledgeBaseEntryDto) {
    return this.prisma.knowledgeBaseEntry.create({ data: { ...dto, tags: dto.tags ?? [] } });
  }

  async deleteKnowledgeBaseEntry(id: string) {
    await this.prisma.knowledgeBaseEntry.update({ where: { id }, data: { isActive: false } });
  }
}

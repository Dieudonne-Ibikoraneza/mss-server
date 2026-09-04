import { randomUUID } from 'crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ChatRole, Language, Prisma, RecommendationDecision, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import {
  availableAreaSqmOf,
  canSeeExactStock,
  getLowStockThreshold,
  stockStatusOf,
} from '@/common/utils/stock-status';
import {
  CHAT_PROVIDER,
  type ChatProductCandidate,
  type ChatProvider,
} from './providers/chat-provider.interface';
import {
  StubImagePreviewProvider,
  StubVideoPreviewProvider,
} from './providers/stub-media.provider';
import {
  RECOMMENDATION_IMAGE_PROVIDER,
  type RecommendationImageProvider,
} from './providers/recommendation-image.provider';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto, VideoPreviewDto } from './dto/media-preview.dto';
import { UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
import { StartConversationDto } from './dto/start-conversation.dto';
import { ListPostRecommendationInquiriesDto } from './dto/list-post-recommendation-inquiries.dto';
import { StorageService } from '@/storage/storage.service';

/** How many active products to ground the assistant with — enough choice without bloating the prompt. */
const MAX_CANDIDATE_PRODUCTS = 40;
/** Length cap for the auto-derived "project" title shown in the customer's conversation list. */
const MAX_TITLE_CHARS = 80;

@Injectable()
export class ChatbotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(CHAT_PROVIDER) private readonly chatProvider: ChatProvider,
    @Inject(RECOMMENDATION_IMAGE_PROVIDER)
    private readonly recommendationImageProvider: RecommendationImageProvider,
    private readonly storage: StorageService,
    private readonly imageProvider: StubImagePreviewProvider,
    private readonly videoProvider: StubVideoPreviewProvider,
  ) {}

  private async getOrCreateConversation(sessionId: string, userId: string, language: Language) {
    const existing = await this.prisma.chatConversation.findFirst({ where: { userId, sessionId } });
    if (existing) return existing;
    return this.prisma.chatConversation.create({ data: { userId, sessionId, language } });
  }

  /** Every recommendation-flow conversation belongs to exactly one signed-in customer —
   * resolving by id here also re-checks ownership, so one customer can never read or
   * post into another's conversation just by guessing/reusing its id. */
  private async resolveOwnedConversation(conversationId: string, userId: string) {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found.');
    }
    return conversation;
  }

  /** Starts a brand-new "project" thread for the customer — used by the chatbot
   * page's "start new" action so a fresh room/spec doesn't get mixed into an
   * existing conversation's history or recommendations. */
  startConversation(userId: string, dto: StartConversationDto) {
    return this.prisma.chatConversation.create({
      data: { userId, sessionId: randomUUID(), language: dto.language ?? Language.EN },
    });
  }

  /** The customer's own conversations ("projects"), most recently active first —
   * what the chatbot page loads on open so a returning customer picks up where
   * they left off, or starts a new one instead. */
  listConversations(userId: string) {
    return this.prisma.chatConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  }

  async sendMessage(dto: SendMessageDto, userId: string) {
    const conversation = dto.conversationId
      ? await this.resolveOwnedConversation(dto.conversationId, userId)
      : await this.getOrCreateConversation(dto.sessionId, userId, dto.language ?? Language.EN);

    // A conversation only starts counting as "post-recommendation" once a prior
    // turn actually produced a recommendation — checked before this message is
    // saved, so the very message that first prompts a recommendation doesn't
    // wrongly count as a follow-up question about one.
    const hadPriorRecommendations =
      (await this.prisma.recommendation.count({ where: { sessionId: conversation.sessionId } })) >
      0;

    const userMessage = await this.prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: ChatRole.USER, content: dto.content },
    });

    if (hadPriorRecommendations) {
      await this.prisma.postRecommendationInquiry.create({
        data: {
          conversationId: conversation.id,
          userId,
          messageId: userMessage.id,
          question: dto.content,
        },
      });
    }

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

    // history includes the message just created above, so length 1 here means
    // this is the conversation's opening message — the best-available title.
    if (!conversation.title && history.length === 1) {
      await this.prisma.chatConversation.update({
        where: { id: conversation.id },
        data: { title: dto.content.slice(0, MAX_TITLE_CHARS) },
      });
    }

    const candidates: ChatProductCandidate[] = candidateProducts.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      size: product.collection.size,
      suitableFor: product.suitableFor,
      roomTypes: product.roomTypes,
      price: Number(product.price),
      currency: product.currency,
      // Reservations held by other customers' unpaid orders count against
      // this — see `availableAreaSqmOf`. The assistant shouldn't recommend
      // tiles someone else already has a payment window locked on.
      stockStatus: stockStatusOf(
        availableAreaSqmOf(Number(product.quantityOnHandSqm), Number(product.reservedAreaSqm)),
        lowStockThreshold,
      ),
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
      history.map((message) => `${message.role}: ${message.content}`).join('\n'),
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
    customerBrief: string,
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

    // Individual creates (not createMany) so each row's real id comes back —
    // the customer's later like/dislike targets this exact recommendation,
    // not just "some recommendation of this product".
    const created = await this.prisma.$transaction(
      resolved.map(({ pick, product, rank }) =>
        this.prisma.recommendation.create({
          data: {
            userId,
            sessionId,
            productId: product.id,
            rank,
            matchScore: pick.matchScore,
            reason: pick.reason,
          },
        }),
      ),
    );

    const generatedImages = await Promise.all(
      resolved.map(async ({ product }) =>
        this.recommendationImageProvider.generate({
          customerBrief,
          product: {
            name: product.name,
            description: product.description,
            collection: product.collection.title,
            size: product.collection.size,
            imageUrl: await this.resolveProductImage(product.image),
          },
        }),
      ),
    );

    return resolved.map(({ pick, product }, index) => ({
      id: product.id,
      recommendationId: created[index].id,
      name: product.name,
      // The catalog image remains a safe fallback if Gemini is unavailable.
      image: generatedImages[index] ?? product.image,
      price: Number(product.price),
      link: `/products/${product.id}`,
      collection: product.collection.title,
      size: product.collection.size,
      matchScore: pick.matchScore,
      reason: pick.reason,
    }));
  }

  private async resolveProductImage(image: string) {
    if (/^https?:\/\//i.test(image)) return image;
    try {
      return await this.storage.getSignedUrl(image);
    } catch {
      return image;
    }
  }

  /** Customer feedback on one recommendation — liked, disliked, or cleared back to pending. */
  async setRecommendationDecision(id: string, decision: RecommendationDecision) {
    await this.findRecommendation(id);
    return this.prisma.recommendation.update({
      where: { id },
      data: {
        decision,
        decidedAt: decision === RecommendationDecision.PENDING ? null : new Date(),
      },
    });
  }

  private async findRecommendation(id: string) {
    const recommendation = await this.prisma.recommendation.findUnique({ where: { id } });
    if (!recommendation) throw new NotFoundException('Recommendation not found.');
    return recommendation;
  }

  async getHistory(conversationId: string, userId: string) {
    await this.resolveOwnedConversation(conversationId, userId);
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
    const products = rows.map(
      ({ quantityOnHandSqm, reservedAreaSqm, averageCostPrice, ...rest }) => ({
        ...rest,
        stockStatus: stockStatusOf(
          availableAreaSqmOf(Number(quantityOnHandSqm), Number(reservedAreaSqm)),
          lowStockThreshold,
        ),
        ...(canSeeExactStock(viewerRole)
          ? {
              quantityOnHandSqm: Number(quantityOnHandSqm),
              reservedAreaSqm: Number(reservedAreaSqm),
              averageCostPrice: Number(averageCostPrice),
            }
          : {}),
      }),
    );

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

  /** Admin/marketing view of every question a customer asked once the assistant
   * had already recommended something in that conversation — surfaces real
   * post-purchase-consideration questions (concerns, objections, follow-ups)
   * without wading through full conversation transcripts. Cursor-paginated
   * for infinite scroll — see the DTO for why. */
  async listPostRecommendationInquiries(dto: ListPostRecommendationInquiriesDto) {
    const limit = dto.limit ?? 20;
    const rows = await this.prisma.postRecommendationInquiry.findMany({
      take: limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true } },
        conversation: { select: { id: true, sessionId: true, language: true, title: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }
}

import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  RECOMMENDATION_IMAGE_PROVIDER,
  type RecommendationImageProvider,
} from './providers/recommendation-image.provider';
import {
  ROOM_TILE_EDIT_PROVIDER,
  type RoomTileEditProvider,
} from './providers/room-tile-provider.interface';
import { downloadReferenceImage } from './providers/gemini-image-client';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto } from './dto/media-preview.dto';
import { UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
import { StartConversationDto } from './dto/start-conversation.dto';
import { ListPostRecommendationInquiriesDto } from './dto/list-post-recommendation-inquiries.dto';
import {
  StorageService,
  RECOMMENDATION_IMAGES_BUCKET,
  ROOM_PHOTOS_BUCKET,
} from '@/storage/storage.service';

/** Shape persisted into `ChatMessage.attachments` for the "put this tile on my
 * floor" feature — read back by `getHistory` on every reload, and by nothing
 * else, so it's safe to reshape freely as the feature grows. */
type RoomPhotoAttachment = { kind: 'room-photo'; path: string };
type RoomTilePreviewAttachment = {
  kind: 'room-tile-preview';
  roomImagePath: string;
  productId: string;
  productName: string;
  generatedImagePath: string | null;
};

/** How many active products to ground the assistant with — enough choice without bloating the prompt. */
const MAX_CANDIDATE_PRODUCTS = 40;
/** Length cap for the auto-derived "project" title shown in the customer's conversation list. */
const MAX_TITLE_CHARS = 80;

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(CHAT_PROVIDER) private readonly chatProvider: ChatProvider,
    @Inject(RECOMMENDATION_IMAGE_PROVIDER)
    private readonly recommendationImageProvider: RecommendationImageProvider,
    @Inject(ROOM_TILE_EDIT_PROVIDER)
    private readonly roomTileProvider: RoomTileEditProvider,
    private readonly storage: StorageService,
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

    // A conversation only starts counting as "post-recommendation" once a
    // prior turn actually produced a recommendation — checked before this
    // message is saved, against the state as it stood before this turn.
    const hadPriorRecommendations =
      (await this.prisma.recommendation.count({ where: { sessionId: conversation.sessionId } })) >
      0;

    const userMessage = await this.prisma.chatMessage.create({
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
      assistantMessage.id,
      history.map((message) => `${message.role}: ${message.content}`).join('\n'),
    );

    // Logged only now that this turn's own outcome is known: a message sent
    // into a conversation that already had a recommendation, but which
    // itself produced a fresh batch of recommendations (e.g. the customer
    // changed the brief and asked again), is a recommendation *request*, not
    // a follow-up question about one — excluded here even though
    // `hadPriorRecommendations` is true, same as every profiling-questionnaire
    // turn before the first recommendation ever exists.
    if (hadPriorRecommendations && products.length === 0) {
      await this.prisma.postRecommendationInquiry.create({
        data: {
          conversationId: conversation.id,
          userId,
          messageId: userMessage.id,
          question: dto.content,
        },
      });
    }

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
    assistantMessageId: string,
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

    // Resolved once per product — reused both as Gemini's reference photo and
    // as the fallback image below. Falling back to `product.image` itself
    // would be wrong for a stored (not external) image: it's a bare blob path
    // like "products/<uuid>.png", not a URL, so the browser can't render it
    // at all — this is what was actually behind a blank/broken tile whenever
    // generation failed, not the generation failure itself.
    const resolvedImageUrls = await Promise.all(
      resolved.map(({ product }) => this.resolveProductImage(product.image)),
    );

    const generatedImages = await Promise.all(
      resolved.map(async ({ product }, index) =>
        this.recommendationImageProvider.generate({
          customerBrief,
          product: {
            name: product.name,
            description: product.description,
            collection: product.collection.title,
            size: product.collection.size,
            imageUrl: resolvedImageUrls[index],
          },
        }),
      ),
    );

    // Persisted once, right away — not regenerated on a later reload, which
    // would both burn a real (quota-consuming, non-deterministic) API call
    // per view and never even reproduce the *same* image. A failed upload
    // just leaves `imagePath` null for that pick — the catalog photo is
    // already the fallback everywhere this is read, same as a failed
    // generation itself.
    const imagePaths = await Promise.all(
      generatedImages.map(async (generated) => {
        if (!generated) return null;
        try {
          return await this.storage.uploadGeneratedImage(
            Buffer.from(generated.data, 'base64'),
            generated.mimeType,
          );
        } catch (error) {
          this.logger.error(
            `Could not persist a generated recommendation image: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          return null;
        }
      }),
    );

    // Individual creates (not createMany) so each row's real id comes back —
    // the customer's later like/dislike targets this exact recommendation,
    // not just "some recommendation of this product". `messageId` is what
    // lets a reloaded conversation re-attach these to the right turn later
    // (see `getHistory`) instead of the cards just disappearing.
    const created = await this.prisma.$transaction(
      resolved.map(({ pick, product, rank }, index) =>
        this.prisma.recommendation.create({
          data: {
            userId,
            sessionId,
            productId: product.id,
            messageId: assistantMessageId,
            imagePath: imagePaths[index],
            rank,
            matchScore: pick.matchScore,
            reason: pick.reason,
          },
        }),
      ),
    );

    return resolved.map(({ pick, product }, index) => ({
      id: product.id,
      recommendationId: created[index].id,
      name: product.name,
      // The freshly generated bytes are rendered directly here (no need to
      // round-trip through the URL we just uploaded them to) — the real
      // catalog photo is the fallback whenever generation itself failed.
      image: generatedImages[index]
        ? `data:${generatedImages[index].mimeType};base64,${generatedImages[index].data}`
        : resolvedImageUrls[index],
      price: Number(product.price),
      link: `/products/${product.id}`,
      collection: product.collection.title,
      size: product.collection.size,
      matchScore: pick.matchScore,
      reason: pick.reason,
    }));
  }

  private async resolveProductImage(image: string, bucket?: string) {
    // Recovers the bare path if `image` was ever saved as one of our own
    // (possibly expired) signed URLs instead — see `ProductsService`'s
    // identical guard for why. Kept in sync with that one intentionally,
    // rather than shared, since the two services don't otherwise depend on
    // each other.
    const signedPathMatch = /\/storage\/v1\/object\/sign\/[^/]+\/(.+?)(?:\?|$)/.exec(image);
    if (signedPathMatch) {
      try {
        return await this.storage.getSignedUrl(decodeURIComponent(signedPathMatch[1]), bucket);
      } catch {
        return image;
      }
    }
    if (/^https?:\/\//i.test(image)) return image;
    try {
      return await this.storage.getSignedUrl(image, bucket);
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

  /**
   * Reattaches each assistant turn's recommended products (and the batch's
   * like/dislike, if any) via `Recommendation.messageId` — without this, a
   * reloaded conversation showed the assistant's text ("here are three tile
   * options...") with no cards under it, since the plain message rows alone
   * carry no memory of what was recommended.
   */
  async getHistory(conversationId: string, userId: string) {
    await this.resolveOwnedConversation(conversationId, userId);
    const messages = await this.prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });

    const assistantMessageIds = messages
      .filter((message) => message.role === ChatRole.ASSISTANT)
      .map((message) => message.id);

    const recommendations = assistantMessageIds.length
      ? await this.prisma.recommendation.findMany({
          where: { messageId: { in: assistantMessageIds } },
          include: { product: { include: { collection: true } } },
          orderBy: { rank: 'asc' },
        })
      : [];

    const byMessageId = new Map<string, typeof recommendations>();
    for (const recommendation of recommendations) {
      if (!recommendation.messageId) continue;
      const bucket = byMessageId.get(recommendation.messageId) ?? [];
      bucket.push(recommendation);
      byMessageId.set(recommendation.messageId, bucket);
    }

    return Promise.all(
      messages.map(async (message) => {
        const attachment = await this.resolveMessageAttachment(message.attachments);
        const batch = byMessageId.get(message.id) ?? [];
        if (batch.length === 0) {
          return { ...message, products: undefined, decision: undefined, attachment };
        }

        const products = await Promise.all(
          batch.map(async (recommendation) => ({
            id: recommendation.product.id,
            recommendationId: recommendation.id,
            name: recommendation.product.name,
            // The persisted AI room visualization is the primary image here
            // — same one shown live, not regenerated — falling back to the
            // real catalog photo only when generation failed or predates
            // `imagePath` (never a broken image either way).
            image: recommendation.imagePath
              ? await this.resolveProductImage(
                  recommendation.imagePath,
                  RECOMMENDATION_IMAGES_BUCKET,
                )
              : await this.resolveProductImage(recommendation.product.image),
            price: Number(recommendation.product.price),
            link: `/products/${recommendation.product.id}`,
            collection: recommendation.product.collection.title,
            size: recommendation.product.collection.size,
            matchScore: Number(recommendation.matchScore),
            reason: recommendation.reason ?? '',
          })),
        );

        // Every recommendation in a batch always carries the same decision
        // (`setRecommendationDecision` / the frontend's `decideBatch` both
        // apply it to the whole batch at once) — any one of them tells us
        // whether this turn's like/dislike was already answered.
        return { ...message, products, decision: batch[0].decision, attachment };
      }),
    );
  }

  /**
   * Reconstructs the "put this tile on my floor" turn on a reloaded
   * conversation from `ChatMessage.attachments` — resolving its stored bare
   * paths into fresh signed URLs, since the ones from the original turn have
   * long since expired. Any other/unrecognized shape (or none) resolves to
   * `undefined`, same as a plain text message.
   */
  private async resolveMessageAttachment(attachments: Prisma.JsonValue | null) {
    if (!attachments || typeof attachments !== 'object' || Array.isArray(attachments)) {
      return undefined;
    }
    const kind = (attachments as { kind?: string }).kind;

    if (kind === 'room-photo') {
      const { path } = attachments as unknown as RoomPhotoAttachment;
      return {
        kind: 'room-photo' as const,
        url: await this.resolveProductImage(path, ROOM_PHOTOS_BUCKET),
      };
    }

    if (kind === 'room-tile-preview') {
      const data = attachments as unknown as RoomTilePreviewAttachment;
      const [roomImageUrl, generatedImageUrl] = await Promise.all([
        this.resolveProductImage(data.roomImagePath, ROOM_PHOTOS_BUCKET),
        data.generatedImagePath
          ? this.resolveProductImage(data.generatedImagePath, RECOMMENDATION_IMAGES_BUCKET)
          : Promise.resolve(null),
      ]);
      return {
        kind: 'room-tile-preview' as const,
        productId: data.productId,
        productName: data.productName,
        roomImageUrl,
        generatedImageUrl,
      };
    }

    return undefined;
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

  /** Persists the customer's own room photo — see `POST /chatbot/preview/room-photo`. */
  async uploadRoomPhoto(file: Express.Multer.File) {
    return this.storage.uploadRoomPhoto(file);
  }

  /**
   * Doc 3.6's "put this tile on my floor" preview: edits the customer's own
   * uploaded room photo with one tile they picked, and saves the whole turn
   * (their photo, then the result) as two ordinary chat messages —
   * `ChatMessage.attachments` is what `getHistory` resolves back into fresh
   * URLs on every reload, so the preview stays visible without regenerating
   * it (a real, quota-consuming API call) on every page load.
   */
  async generateImagePreview(dto: ImagePreviewDto, userId: string) {
    await this.resolveOwnedConversation(dto.conversationId, userId);

    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { collection: true },
    });
    if (!product) throw new NotFoundException('Product not found.');

    const userMessage = await this.prisma.chatMessage.create({
      data: {
        conversationId: dto.conversationId,
        role: ChatRole.USER,
        content:
          dto.note?.trim() ||
          `Here's a photo of my room — show me the ${product.name} tile on the floor.`,
        attachments: {
          kind: 'room-photo',
          path: dto.roomImagePath,
        } satisfies RoomPhotoAttachment,
      },
    });

    const job = await this.prisma.chatMediaJob.create({
      data: {
        conversationId: dto.conversationId,
        type: 'IMAGE_PREVIEW',
        status: 'PROCESSING',
        inputUrl: dto.roomImagePath,
      },
    });

    const [roomImage, tileImage] = await Promise.all([
      this.storage.downloadImage(dto.roomImagePath, ROOM_PHOTOS_BUCKET),
      downloadReferenceImage(await this.resolveProductImage(product.image)),
    ]);

    const generated =
      roomImage && tileImage
        ? await this.roomTileProvider.generate({
            roomImage,
            tileImage,
            product: {
              name: product.name,
              collection: product.collection.title,
              size: product.collection.size,
              description: product.description,
            },
          })
        : null;

    // Persisted once, right away — same reasoning as the recommendation
    // visuals below it in this file: a reloaded conversation must show the
    // exact same edit, not a freshly (and differently) regenerated one, and
    // a failed upload just leaves this null, same as a failed generation.
    let generatedImagePath: string | null = null;
    if (generated) {
      try {
        generatedImagePath = await this.storage.uploadGeneratedImage(
          Buffer.from(generated.data, 'base64'),
          generated.mimeType,
          'room-tile-previews',
        );
      } catch (error) {
        this.logger.error(
          `Could not persist a room/tile preview image: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    await this.prisma.chatMediaJob.update({
      where: { id: job.id },
      data: {
        status: generatedImagePath ? 'COMPLETED' : 'FAILED',
        outputUrl: generatedImagePath,
        error: generatedImagePath ? null : 'Image generation failed or returned no image.',
      },
    });

    const assistantMessage = await this.prisma.chatMessage.create({
      data: {
        conversationId: dto.conversationId,
        role: ChatRole.ASSISTANT,
        content: generatedImagePath
          ? `Here's how ${product.name} would look on your floor.`
          : `Sorry, I couldn't generate a preview for ${product.name} right now — please try again in a moment.`,
        attachments: {
          kind: 'room-tile-preview',
          roomImagePath: dto.roomImagePath,
          productId: product.id,
          productName: product.name,
          generatedImagePath,
        } satisfies RoomTilePreviewAttachment,
      },
    });

    const [roomImageUrl, generatedImageUrl] = await Promise.all([
      this.resolveProductImage(dto.roomImagePath, ROOM_PHOTOS_BUCKET),
      generatedImagePath
        ? this.resolveProductImage(generatedImagePath, RECOMMENDATION_IMAGES_BUCKET)
        : Promise.resolve(null),
    ]);

    return {
      userMessage: {
        id: userMessage.id,
        role: userMessage.role,
        content: userMessage.content,
        createdAt: userMessage.createdAt,
        attachment: { kind: 'room-photo' as const, url: roomImageUrl },
      },
      assistantMessage: {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        attachment: {
          kind: 'room-tile-preview' as const,
          productId: product.id,
          productName: product.name,
          roomImageUrl,
          generatedImageUrl,
        },
      },
    };
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

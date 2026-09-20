import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { notFound } from '@/common/errors/app-error';
import {
  ChatRole,
  Language,
  Prisma,
  RecommendationDecision,
  Role,
  RoomSurface,
} from '@prisma/client';
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
import { TranslationService } from '@/translation/translation.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CompareProductsDto } from './dto/compare-products.dto';
import { ImagePreviewDto } from './dto/media-preview.dto';
import { UpdateKnowledgeBaseEntryDto, UpsertKnowledgeBaseEntryDto } from './dto/knowledge-base.dto';
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
    private readonly translation: TranslationService,
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
      throw notFound('chatbot.conversationNotFound', 'Conversation not found.');
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

  async sendMessage(dto: SendMessageDto, userId: string, role: Role) {
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
      this.recentMessages(conversation.id),
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
    // Staff use the chatbot too (testing, demoing to a walk-in customer),
    // but the "asked questions" analytics (`/admin/asked-questions`,
    // `listPostRecommendationInquiries`) exists to surface real customer
    // intent — a stock manager's test questions would just be noise there,
    // so only a CLIENT's follow-up gets logged.
    if (hadPriorRecommendations && products.length === 0 && role === Role.CLIENT) {
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
    picks: { productId: string; wallProductId?: string; matchScore: number; reason: string }[],
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
    type CandidateProduct = (typeof candidateProducts)[number];
    const resolved = picks
      .map((pick, index) => {
        const product = byId.get(pick.productId);
        if (!product) return null;
        // A wallProductId that no longer resolves (candidate list changed
        // between provider call and here — practically never, but cheap to
        // guard) just falls back to a single-product pick.
        const wallProduct = pick.wallProductId ? (byId.get(pick.wallProductId) ?? null) : null;
        return { pick, product, wallProduct, rank: index + 1 };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (resolved.length === 0) return [];

    // Resolved once per product — reused both as Gemini's reference photo and
    // as the fallback image below. Falling back to `product.image` itself
    // would be wrong for a stored (not external) image: it's a bare blob path
    // like "products/<uuid>.png", not a URL, so the browser can't render it
    // at all — this is what was actually behind a blank/broken tile whenever
    // generation failed, not the generation failure itself.
    const floorImageUrls = await Promise.all(
      resolved.map(({ product }) => this.resolveProductImage(product.image)),
    );
    const wallImageUrls = await Promise.all(
      resolved.map(({ wallProduct }) =>
        wallProduct ? this.resolveProductImage(wallProduct.image) : Promise.resolve(null),
      ),
    );

    // One generation call per pick, whether it's a single tile or a bathroom
    // floor+wall combo — the combo still renders as one finished room scene,
    // shared by both of that pick's cards below, so this never costs more
    // API calls than today's one-per-pick.
    const generatedImages = await Promise.all(
      resolved.map(async ({ product, wallProduct }, index) =>
        this.recommendationImageProvider.generate({
          customerBrief,
          product: {
            name: product.name,
            description: product.description,
            collection: product.collection.title,
            size: product.collection.size,
            imageUrl: floorImageUrls[index],
          },
          ...(wallProduct && wallImageUrls[index]
            ? {
                wallProduct: {
                  name: wallProduct.name,
                  description: wallProduct.description,
                  collection: wallProduct.collection.title,
                  size: wallProduct.collection.size,
                  imageUrl: wallImageUrls[index],
                },
              }
            : {}),
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

    // Flattened: a bathroom combo pick becomes two rows (the floor product,
    // then the wall product) that share the same rank and the same generated
    // scene — everything else about them (create, resolve) is identical to a
    // single-product pick, just repeated for each surface. They're persisted
    // as two real rows (so each product still gets its own like/dislike and
    // purchase-attribution history), but merged back into ONE card below —
    // the customer asked for exactly 3 recommendations, not 3 floor tiles
    // plus 3 wall tiles shown as 6 separate cards.
    type Row = {
      pickIndex: number;
      rank: number;
      matchScore: number;
      reason: string;
      product: CandidateProduct;
      surface: RoomSurface | null;
    };
    const rows: Row[] = resolved.flatMap(
      ({ pick, product, wallProduct, rank }, pickIndex): Row[] => {
        const base = { pickIndex, rank, matchScore: pick.matchScore, reason: pick.reason };
        if (!wallProduct) return [{ ...base, product, surface: null }];
        return [
          { ...base, product, surface: RoomSurface.FLOOR },
          { ...base, product: wallProduct, surface: RoomSurface.WALL },
        ];
      },
    );

    // Individual creates (not createMany) so each row's real id comes back —
    // the customer's later like/dislike targets this exact recommendation,
    // not just "some recommendation of this product". `messageId` is what
    // lets a reloaded conversation re-attach these to the right turn later
    // (see `getHistory`) instead of the cards just disappearing.
    const created = await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.recommendation.create({
          data: {
            userId,
            sessionId,
            productId: row.product.id,
            messageId: assistantMessageId,
            imagePath: imagePaths[row.pickIndex],
            rank: row.rank,
            surface: row.surface,
            matchScore: row.matchScore,
            reason: row.reason,
          },
        }),
      ),
    );

    return resolved.map((_, pickIndex) => {
      const rowIndices = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.pickIndex === pickIndex);
      const floorEntry = rowIndices.find(({ row }) => row.surface !== RoomSurface.WALL)!;
      const wallEntry = rowIndices.find(({ row }) => row.surface === RoomSurface.WALL);

      const generated = generatedImages[pickIndex];
      const fallbackUrl = floorImageUrls[pickIndex];
      // The freshly generated bytes are rendered directly here (no need to
      // round-trip through the URL we just uploaded them to) — the real
      // catalog photo is the fallback whenever generation itself failed.
      const image = generated
        ? `data:${generated.mimeType};base64,${generated.data}`
        : (fallbackUrl ?? '');

      return {
        id: floorEntry.row.product.id,
        recommendationId: created[floorEntry.index].id,
        name: floorEntry.row.product.name,
        image,
        price: Number(floorEntry.row.product.price),
        link: `/products/${floorEntry.row.product.id}`,
        collection: floorEntry.row.product.collection.title,
        size: floorEntry.row.product.collection.size,
        matchScore: floorEntry.row.matchScore,
        reason: floorEntry.row.reason,
        ...(wallEntry
          ? {
              wallProduct: {
                id: wallEntry.row.product.id,
                recommendationId: created[wallEntry.index].id,
                name: wallEntry.row.product.name,
                price: Number(wallEntry.row.product.price),
                link: `/products/${wallEntry.row.product.id}`,
                collection: wallEntry.row.product.collection.title,
                size: wallEntry.row.product.collection.size,
              },
            }
          : {}),
      };
    });
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

  /**
   * Customer feedback on one recommendation — liked, disliked, or cleared back to pending.
   * Only the customer it was made for may change it; anyone else (or a made-up id) gets the
   * same "not found", so ids can't be probed and analytics can't be skewed from outside.
   */
  async setRecommendationDecision(id: string, decision: RecommendationDecision, userId: string) {
    const recommendation = await this.prisma.recommendation.findUnique({ where: { id } });
    if (!recommendation || recommendation.userId !== userId) {
      throw notFound('chatbot.recommendationNotFound', 'Recommendation not found.');
    }
    return this.prisma.recommendation.update({
      where: { id },
      data: {
        decision,
        decidedAt: decision === RecommendationDecision.PENDING ? null : new Date(),
      },
      select: { id: true, decision: true },
    });
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

        // A bathroom combo's two rows (floor + wall) share the same `rank`
        // and were shown as one card originally — grouping by rank here is
        // what re-merges them on reload instead of surfacing 6 cards for 3
        // recommendations. `batch` is already ordered by rank asc, so this
        // preserves the original order.
        const byRank = new Map<number, typeof batch>();
        for (const recommendation of batch) {
          const group = byRank.get(recommendation.rank) ?? [];
          group.push(recommendation);
          byRank.set(recommendation.rank, group);
        }

        const products = await Promise.all(
          Array.from(byRank.values()).map(async (group) => {
            // Rows created before the `surface` column existed are both
            // untagged (null) — falling back to "the second row in the pair
            // is the wall one" (their original creation/rank-tie order) so
            // those older conversations still reload as one merged card
            // instead of silently losing whichever row `.find` skips.
            const explicitWall = group.find((r) => r.surface === RoomSurface.WALL);
            const wall = explicitWall ?? (group.length > 1 ? group[group.length - 1] : undefined);
            const floor = group.find((r) => r !== wall) ?? group[0];

            const resolveCardImage = async (recommendation: (typeof group)[number]) =>
              // The persisted AI room visualization is the primary image
              // here — same one shown live, not regenerated — falling back
              // to the real catalog photo only when generation failed or
              // predates `imagePath` (never a broken image either way).
              recommendation.imagePath
                ? this.resolveProductImage(recommendation.imagePath, RECOMMENDATION_IMAGES_BUCKET)
                : this.resolveProductImage(recommendation.product.image);

            return {
              id: floor.product.id,
              recommendationId: floor.id,
              name: floor.product.name,
              image: await resolveCardImage(floor),
              price: Number(floor.product.price),
              link: `/products/${floor.product.id}`,
              collection: floor.product.collection.title,
              size: floor.product.collection.size,
              matchScore: Number(floor.matchScore),
              reason: floor.reason ?? '',
              ...(wall
                ? {
                    wallProduct: {
                      id: wall.product.id,
                      recommendationId: wall.id,
                      name: wall.product.name,
                      price: Number(wall.product.price),
                      link: `/products/${wall.product.id}`,
                      collection: wall.product.collection.title,
                      size: wall.product.collection.size,
                    },
                  }
                : {}),
            };
          }),
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
      throw notFound('catalog.productsNotFound', 'One or more products could not be found.');
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
    if (!product) throw notFound('catalog.productNotFound', 'Product not found.');

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

  /**
   * The newest `limit` turns of a conversation, oldest first — what the model is
   * shown as context. Taking the first N by date instead meant that once a
   * conversation passed N messages the model stopped seeing anything recent,
   * including the message that had just been sent.
   */
  recentMessages(conversationId: string, limit = 20) {
    return this.prisma.chatMessage
      .findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      .then((recent) => recent.reverse());
  }

  listKnowledgeBase() {
    return this.prisma.knowledgeBaseEntry.findMany({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  listKnowledgeBaseForAdmin() {
    return this.prisma.knowledgeBaseEntry.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  /**
   * The assistant grounds itself strictly on entries matching the
   * conversation's own language (see the `knowledgeBaseEntry.findMany` call
   * above) — an entry written only in EN is invisible to every RW
   * conversation. Rather than expect staff to write every entry twice,
   * creating one in EN auto-creates its RW twin (translated question +
   * answer, same tags) as a second real row.
   */
  async createKnowledgeBaseEntry(dto: UpsertKnowledgeBaseEntryDto) {
    const entry = await this.prisma.knowledgeBaseEntry.create({
      data: { ...dto, tags: dto.tags ?? [] },
    });

    if (entry.language === Language.EN) {
      const translated = await this.translation.translateFields(
        { question: entry.question, answer: entry.answer },
        Language.EN,
        Language.RW,
      );
      if (translated.question && translated.answer) {
        await this.prisma.knowledgeBaseEntry.create({
          data: {
            question: translated.question,
            answer: translated.answer,
            tags: entry.tags,
            language: Language.RW,
            translatedFromId: entry.id,
          },
        });
      }
    }

    return entry;
  }

  async updateKnowledgeBaseEntry(id: string, dto: UpdateKnowledgeBaseEntryDto) {
    const existing = await this.prisma.knowledgeBaseEntry.findUnique({ where: { id } });
    if (!existing)
      throw notFound('chatbot.knowledgeEntryNotFound', 'Knowledge base entry not found.');

    return this.prisma.knowledgeBaseEntry.update({
      where: { id },
      data: dto,
    });
  }

  async deleteKnowledgeBaseEntry(id: string) {
    const existing = await this.prisma.knowledgeBaseEntry.findUnique({ where: { id } });
    if (!existing)
      throw notFound('chatbot.knowledgeEntryNotFound', 'Knowledge base entry not found.');

    await this.prisma.knowledgeBaseEntry.deleteMany({
      where: { OR: [{ id }, { translatedFromId: id }] },
    });
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

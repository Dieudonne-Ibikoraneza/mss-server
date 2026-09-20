import { Injectable } from '@nestjs/common';
import { badRequest, forbidden, notFound } from '@/common/errors/app-error';
import { JourneyStage, Prisma, Role, TileEventType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';

interface RecordTileEventInput {
  userId?: string | null;
  /** Absent for an anonymous caller — see `isStaffRole` below. */
  role?: Role;
  sessionId: string;
  productId: string;
  type: TileEventType;
  metadata?: Record<string, unknown>;
}

interface RecordJourneyEventInput {
  userId?: string | null;
  role?: Role;
  sessionId: string;
  stage: JourneyStage;
  metadata?: Record<string, unknown>;
}

/**
 * Tile-interaction and journey-funnel analytics exist to understand real
 * customer behaviour — a staff member browsing the storefront (testing,
 * demoing, using their own toolbar) isn't a customer, and their clicks would
 * skew "Top Viewed Tiles" and the journey funnel if counted. An anonymous
 * caller (no `role` at all) still counts: they're a prospective customer who
 * just hasn't signed in yet.
 */
const isStaffRole = (role?: Role) => role !== undefined && role !== Role.CLIENT;

/** Outcomes backed by a real server-side action are deliberately absent from these public lists. */
const PUBLIC_TILE_EVENT_TYPES = new Set<TileEventType>([
  TileEventType.VIEWED,
  TileEventType.APPLIED,
]);

const PUBLIC_JOURNEY_STAGES = new Set<JourneyStage>([
  JourneyStage.OPENED_SYSTEM,
  JourneyStage.CREATED_ROOM,
  JourneyStage.ENTERED_DIMENSIONS,
  JourneyStage.VIEWED_TILE,
  JourneyStage.APPLIED_TILE,
]);

const TILE_DEDUP_TTL_SECONDS: Record<TileEventType, number> = {
  VIEWED: 60,
  APPLIED: 15,
  COMPARED: 60,
  SAVED: 60,
  SELECTED_FROM_RECOMMENDATION: 60,
  PURCHASED: 60,
};

const MAX_METADATA_BYTES = 2_048;

/**
 * Central write path for the raw interaction events that back every
 * dashboard in 3.9 (tile interaction analytics, journey funnel, AI
 * recommendation performance). Every feature module that touches a product
 * (view, apply-in-3d, compare, save, purchase) calls in here rather than
 * writing analytics rows itself, so the funnel logic stays in one place.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private assertMetadataSize(metadata?: Record<string, unknown>) {
    if (metadata && Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
      throw badRequest('events.metadataTooLarge', 'Event metadata must not exceed {{max}} bytes.', {
        max: MAX_METADATA_BYTES,
      });
    }
  }

  /** Public callers may report observable UI activity, never authoritative business outcomes. */
  async recordPublicTileEvent(input: RecordTileEventInput) {
    if (isStaffRole(input.role)) return null;
    if (!PUBLIC_TILE_EVENT_TYPES.has(input.type)) {
      throw forbidden(
        'events.tileEventServerOnly',
        'This tile event can only be recorded by a trusted server action.',
      );
    }
    this.assertMetadataSize(input.metadata);

    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, isActive: true },
    });
    if (!product?.isActive) throw notFound('catalog.productNotFound', 'Product not found.');

    const identity = input.userId ?? input.sessionId;
    const dedupKey = `events:dedup:tile:${identity}:${input.productId}:${input.type}`;
    const accepted = await this.redis.setIfAbsent(
      dedupKey,
      '1',
      TILE_DEDUP_TTL_SECONDS[input.type],
    );
    if (!accepted) return null;

    try {
      return await this.recordTileEvent(input);
    } catch (error) {
      await this.redis.del(dedupKey);
      throw error;
    }
  }

  /** Later funnel stages are written by their order/design/quotation services, not by browsers. */
  async recordPublicJourneyEvent(input: RecordJourneyEventInput) {
    if (isStaffRole(input.role)) return null;
    if (!PUBLIC_JOURNEY_STAGES.has(input.stage)) {
      throw forbidden(
        'events.journeyStageServerOnly',
        'This journey stage can only be recorded by a trusted server action.',
      );
    }
    this.assertMetadataSize(input.metadata);

    const identity = input.userId ?? input.sessionId;
    const dedupKey = `events:dedup:journey:${identity}:${input.stage}`;
    const accepted = await this.redis.setIfAbsent(dedupKey, '1', 24 * 60 * 60);
    if (!accepted) return null;

    try {
      return await this.recordJourneyEvent(input);
    } catch (error) {
      await this.redis.del(dedupKey);
      throw error;
    }
  }

  recordTileEvent(input: RecordTileEventInput) {
    if (isStaffRole(input.role)) return Promise.resolve(null);
    return this.prisma.tileEvent.create({
      data: {
        userId: input.userId ?? undefined,
        sessionId: input.sessionId,
        productId: input.productId,
        type: input.type,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  recordJourneyEvent(input: RecordJourneyEventInput) {
    if (isStaffRole(input.role)) return Promise.resolve(null);
    return this.prisma.customerJourneyEvent.create({
      data: {
        userId: input.userId ?? undefined,
        sessionId: input.sessionId,
        stage: input.stage,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

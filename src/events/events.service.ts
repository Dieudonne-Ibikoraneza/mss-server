import { Injectable } from '@nestjs/common';
import { JourneyStage, Prisma, Role, TileEventType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

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

/**
 * Central write path for the raw interaction events that back every
 * dashboard in 3.9 (tile interaction analytics, journey funnel, AI
 * recommendation performance). Every feature module that touches a product
 * (view, apply-in-3d, compare, save, purchase) calls in here rather than
 * writing analytics rows itself, so the funnel logic stays in one place.
 */
@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

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

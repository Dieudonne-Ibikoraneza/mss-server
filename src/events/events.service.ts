import { Injectable } from '@nestjs/common';
import { JourneyStage, Prisma, TileEventType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

interface RecordTileEventInput {
  userId?: string | null;
  sessionId: string;
  productId: string;
  type: TileEventType;
  metadata?: Record<string, unknown>;
}

interface RecordJourneyEventInput {
  userId?: string | null;
  sessionId: string;
  stage: JourneyStage;
  metadata?: Record<string, unknown>;
}

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

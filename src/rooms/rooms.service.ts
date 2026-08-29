import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  findAllRooms() {
    return this.prisma.room.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  createRoom(dto: CreateRoomDto) {
    return this.prisma.room.create({ data: dto });
  }

  async saveDesign(userId: string, dto: SaveRoomDesignDto) {
    const room = await this.prisma.room.findUnique({ where: { id: dto.roomId } });
    if (!room) throw new NotFoundException('Room not found.');

    // One product per surface — a design can't apply two different floor
    // tiles at once, so a duplicate surface in the payload is a client bug.
    const surfaces = new Set(dto.tiles.map((tile) => tile.surface));
    if (surfaces.size !== dto.tiles.length) {
      throw new BadRequestException('Each surface (FLOOR, WALL) can only be applied once.');
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.tiles.map((tile) => tile.productId) } },
      select: { id: true, name: true, suitableFor: true },
    });
    for (const tile of dto.tiles) {
      const product = products.find((p) => p.id === tile.productId);
      if (!product) {
        throw new BadRequestException(`Product ${tile.productId} could not be found.`);
      }
      // BOTH-rated products go on either surface; FLOOR/WALL-only products
      // can only be placed where they're actually rated for.
      if (product.suitableFor !== SuitableFor.BOTH && product.suitableFor !== tile.surface) {
        throw new BadRequestException(
          `"${product.name}" is a ${product.suitableFor.toLowerCase()} tile and can't be placed on the ${tile.surface.toLowerCase()}.`,
        );
      }
    }

    const design = await this.prisma.roomDesign.create({
      data: {
        userId,
        roomId: dto.roomId,
        name: dto.name,
        previewImageUrl: dto.previewImageUrl,
        sharedWithSales: dto.sharedWithSales ?? false,
        tiles: {
          create: dto.tiles.map((tile) => ({ surface: tile.surface, productId: tile.productId })),
        },
      },
      include: { tiles: { include: { product: true } }, room: true },
    });

    await Promise.all(
      dto.tiles.map((tile) =>
        this.events.recordTileEvent({
          userId,
          sessionId: userId,
          productId: tile.productId,
          type: 'APPLIED',
        }),
      ),
    );
    await this.events.recordJourneyEvent({ userId, sessionId: userId, stage: 'SAVED_DESIGN' });

    return design;
  }

  findMyDesigns(userId: string) {
    return this.prisma.roomDesign.findMany({
      where: { userId },
      include: { tiles: { include: { product: true } }, room: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findDesign(id: string, actingUserId: string, isStaff: boolean) {
    const design = await this.prisma.roomDesign.findUnique({
      where: { id },
      include: { tiles: { include: { product: true } }, room: true, user: true },
    });
    if (!design) throw new NotFoundException('Design not found.');
    if (!isStaff && design.userId !== actingUserId && !design.sharedWithSales) {
      throw new ForbiddenException('You do not have access to this design.');
    }
    return design;
  }

  /** Designs a client has explicitly shared, for the sales team to review. */
  findSharedDesigns() {
    return this.prisma.roomDesign.findMany({
      where: { sharedWithSales: true },
      include: { tiles: { include: { product: true } }, room: true, user: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { ProductsService } from '@/products/products.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';

/** Every design read carries its tiles, each tile's product (+ collection), the room, and the owner. */
const DESIGN_INCLUDE = {
  tiles: { include: { product: { include: { collection: true } } } },
  room: true,
  user: true,
} satisfies Prisma.RoomDesignInclude;

type DesignWithRelations = Prisma.RoomDesignGetPayload<{ include: typeof DESIGN_INCLUDE }>;

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly products: ProductsService,
  ) {}

  findAllRooms() {
    return this.prisma.room.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  createRoom(dto: CreateRoomDto) {
    return this.prisma.room.create({ data: dto });
  }

  /**
   * Runs each tile's product through the catalog serializer so the design's
   * embedded products carry a signed image URL and `size`/`stockStatus`, the
   * same shape the account "Saved designs" page already renders for a product.
   */
  private async withSerializedTiles<T extends DesignWithRelations>(design: T) {
    const serialized = await this.products.serializeEmbedded(
      design.tiles.map((tile) => tile.product),
    );
    return {
      ...design,
      tiles: design.tiles.map((tile, index) => ({ ...tile, product: serialized[index] })),
    };
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
      include: DESIGN_INCLUDE,
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

    return this.withSerializedTiles(design);
  }

  async findMyDesigns(userId: string) {
    const designs = await this.prisma.roomDesign.findMany({
      where: { userId },
      include: DESIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(designs.map((design) => this.withSerializedTiles(design)));
  }

  async findDesign(id: string, actingUserId: string, isStaff: boolean) {
    const design = await this.prisma.roomDesign.findUnique({
      where: { id },
      include: DESIGN_INCLUDE,
    });
    if (!design) throw new NotFoundException('Design not found.');
    if (!isStaff && design.userId !== actingUserId && !design.sharedWithSales) {
      throw new ForbiddenException('You do not have access to this design.');
    }
    return this.withSerializedTiles(design);
  }

  /** Designs a client has explicitly shared, for the sales team to review. */
  async findSharedDesigns() {
    const designs = await this.prisma.roomDesign.findMany({
      where: { sharedWithSales: true },
      include: DESIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(designs.map((design) => this.withSerializedTiles(design)));
  }
}

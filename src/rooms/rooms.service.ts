import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Language, Prisma, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { ProductsService } from '@/products/products.service';
import { TranslationService } from '@/translation/translation.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
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
    private readonly translation: TranslationService,
  ) {}

  findAllRooms() {
    return this.prisma.room.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  /** Every room template, published or hidden — the admin content-management list (doc 3.10). */
  findAllRoomsForAdmin() {
    return this.prisma.room.findMany({ orderBy: { name: 'asc' } });
  }

  async createRoom(dto: CreateRoomDto) {
    // Room templates are admin-authored copy, always in English — no
    // Kinyarwanda-locale editing surface exists for these (unlike
    // products/collections), so this direction is always EN -> RW.
    const translated = await this.translation.translateFields(
      { name: dto.name, description: dto.description },
      Language.EN,
      Language.RW,
    );
    return this.prisma.room.create({
      data: {
        ...dto,
        nameRw: translated.name ?? null,
        descriptionRw: translated.description ?? null,
      },
    });
  }

  async updateRoom(id: string, dto: UpdateRoomDto) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found.');
    const translated = await this.translation.translateFields(
      { name: dto.name, description: dto.description },
      Language.EN,
      Language.RW,
    );
    return this.prisma.room.update({
      where: { id },
      data: { ...dto, nameRw: translated.name, descriptionRw: translated.description },
    });
  }

  /**
   * A room with saved customer designs against it can't be hard-deleted —
   * `RoomDesign.roomId` has no cascade, so Postgres would just reject it —
   * and silently cascading those designs away would be worse: they're a
   * customer's own saved work, not disposable admin content. Hiding it
   * (`updateRoom` with `isActive: false`) is the real "retire this room"
   * action; deleting is only for one nobody ever actually used.
   */
  async deleteRoom(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found.');

    const designCount = await this.prisma.roomDesign.count({ where: { roomId: id } });
    if (designCount > 0) {
      throw new BadRequestException(
        `${designCount} saved customer design${designCount === 1 ? '' : 's'} still use this room — hide it instead of deleting.`,
      );
    }

    await this.prisma.room.delete({ where: { id } });
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

import { Injectable } from '@nestjs/common';
import { badRequest, forbidden, notFound } from '@/common/errors/app-error';
import { Language, Prisma, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { ProductsService } from '@/products/products.service';
import { TranslationService } from '@/translation/translation.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';
import { ListSharedDesignsDto } from './dto/list-shared-designs.dto';
import { decodeCursor, encodeCursor } from '@/common/utils/cursor';

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
    if (!room) throw notFound('rooms.notFound', 'Room not found.');
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
    if (!room) throw notFound('rooms.notFound', 'Room not found.');

    const designCount = await this.prisma.roomDesign.count({ where: { roomId: id } });
    if (designCount > 0) {
      throw designCount === 1
        ? badRequest(
            'rooms.usedByOneDesign',
            '{{count}} saved customer design still use this room — hide it instead of deleting.',
            { count: designCount },
          )
        : badRequest(
            'rooms.usedByDesigns',
            '{{count}} saved customer designs still use this room — hide it instead of deleting.',
            { count: designCount },
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
    if (!room) throw notFound('rooms.notFound', 'Room not found.');

    // One product per surface — a design can't apply two different floor
    // tiles at once, so a duplicate surface in the payload is a client bug.
    const surfaces = new Set(dto.tiles.map((tile) => tile.surface));
    if (surfaces.size !== dto.tiles.length) {
      throw badRequest(
        'rooms.surfaceRepeated',
        'Each surface (FLOOR, WALL) can only be applied once.',
      );
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.tiles.map((tile) => tile.productId) } },
      select: { id: true, name: true, suitableFor: true },
    });
    for (const tile of dto.tiles) {
      const product = products.find((p) => p.id === tile.productId);
      if (!product) {
        throw badRequest('rooms.tileProductNotFound', 'Product {{id}} could not be found.', {
          id: tile.productId,
        });
      }
      // BOTH-rated products go on either surface; FLOOR/WALL-only products
      // can only be placed where they're actually rated for.
      if (product.suitableFor !== SuitableFor.BOTH && product.suitableFor !== tile.surface) {
        throw badRequest(
          'rooms.tileWrongSurface',
          '"{{name}}" is a {{tile}} tile and can\'t be placed on the {{surface}}.',
          {
            name: product.name,
            tile: product.suitableFor.toLowerCase(),
            surface: tile.surface.toLowerCase(),
          },
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
    if (!design) throw notFound('rooms.designNotFound', 'Design not found.');
    if (!isStaff && design.userId !== actingUserId && !design.sharedWithSales) {
      throw forbidden('rooms.designNoAccess', 'You do not have access to this design.');
    }
    return this.withSerializedTiles(design);
  }

  /**
   * Designs a client has explicitly shared, for staff to review — newest
   * first, one page at a time (`limit` + a keyset `cursor`), optionally
   * narrowed by `search`. Only the returned page's tiles get their product
   * images signed, so cost tracks the page size, not the number of shares.
   */
  async findSharedDesigns(query: ListSharedDesignsDto = {}) {
    const limit = query.limit ?? 12;
    const search = query.search?.trim();

    const filters: Prisma.RoomDesignWhereInput[] = [{ sharedWithSales: true }];
    if (search) {
      const contains = { contains: search, mode: 'insensitive' } as const;
      filters.push({
        OR: [
          { name: contains },
          { room: { name: contains } },
          { room: { nameRw: contains } },
          { user: { fullName: contains } },
          { user: { email: contains } },
        ],
      });
    }
    if (query.cursor) {
      const { at, id } = decodeCursor(query.cursor);
      filters.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }

    const rows = await this.prisma.roomDesign.findMany({
      where: { AND: filters },
      include: DESIGN_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((design) => this.withSerializedTiles(design))),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

import { bestEffort } from '@/redis/best-effort';
import { Injectable } from '@nestjs/common';
import { badRequest, forbidden, notFound } from '@/common/errors/app-error';
import { Prisma, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EventsService } from '@/events/events.service';
import { ProductsService } from '@/products/products.service';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SaveRoomDesignDto } from './dto/save-room-design.dto';
import { ListSharedDesignsDto } from './dto/list-shared-designs.dto';
import { decodeCursor, encodeCursor } from '@/common/utils/cursor';
import { ROOM_THUMBNAILS_BUCKET, StorageService } from '@/storage/storage.service';

/** Every design read carries its tiles, each tile's product (+ collection), the room, and the owner. */
const DESIGN_INCLUDE = {
  tiles: { include: { product: { include: { collection: true } } } },
  room: true,
  // Only what staff need to contact the owner — never the whole account record.
  user: { select: { id: true, fullName: true, email: true, phone: true } },
} satisfies Prisma.RoomDesignInclude;

type DesignWithRelations = Prisma.RoomDesignGetPayload<{ include: typeof DESIGN_INCLUDE }>;

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly products: ProductsService,
    private readonly storage: StorageService,
  ) {}

  async findAllRooms() {
    const rooms = await this.prisma.room.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    return Promise.all(rooms.map((room) => this.withThumbnailUrl(room)));
  }

  /** Every room template, published or hidden — the admin content-management list (doc 3.10). */
  async findAllRoomsForAdmin() {
    const rooms = await this.prisma.room.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(rooms.map((room) => this.withThumbnailUrl(room)));
  }

  private async withThumbnailUrl<T extends { thumbnail: string | null }>(room: T) {
    if (!room.thumbnail || !room.thumbnail.startsWith('rooms/')) return room;
    return { ...room, thumbnail: await this.storage.getSignedUrl(room.thumbnail, ROOM_THUMBNAILS_BUCKET) };
  }

  async updateRoom(id: string, dto: UpdateRoomDto) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw notFound('rooms.notFound', 'Room not found.');
    const updated = await this.prisma.room.update({ where: { id }, data: { thumbnail: dto.thumbnail } });
    return this.withThumbnailUrl(updated);
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
      room: design.room ? await this.withThumbnailUrl(design.room) : design.room,
      tiles: design.tiles.map((tile, index) => ({ ...tile, product: serialized[index] })),
    };
  }

  async saveDesign(userId: string, dto: SaveRoomDesignDto) {
    const room = await this.prisma.room.findUnique({ where: { id: dto.roomId } });
    // A hidden room is gone as far as customers are concerned, whatever a stale tab still sends.
    if (!room?.isActive) throw notFound('rooms.notFound', 'Room not found.');

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
      select: { id: true, name: true, suitableFor: true, isActive: true },
    });
    for (const tile of dto.tiles) {
      const product = products.find((p) => p.id === tile.productId);
      if (!product?.isActive) {
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

    // The design is saved; analytics are best-effort, so a failure there can't make the customer
    // retry and save it twice.
    await bestEffort('record the saved design', async () => {
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
    });

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
    // The owner sees their own designs. Staff see a design only once its owner has shared it
    // with sales — a private design stays private, and one customer never reads another's.
    const allowed = design.userId === actingUserId || (isStaff && design.sharedWithSales);
    if (!allowed) {
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

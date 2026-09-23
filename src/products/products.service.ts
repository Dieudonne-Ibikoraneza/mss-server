import { bestEffort } from '@/redis/best-effort';
import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '@/common/errors/app-error';
import { Language, Prisma, Role, StockMovementType, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { StorageService } from '@/storage/storage.service';
import { OrdersService } from '@/orders/orders.service';
import { TranslationService } from '@/translation/translation.service';
import { paginate } from '@/common/dto/pagination.dto';
import { slugify } from '@/common/utils/slugify';
import { calculateTileQuantity, piecesFromAreaSqm } from '@/common/utils/tile-calculator';
import {
  availableAreaSqmOf,
  canSeeExactStock,
  getLowStockThreshold,
  stockStatusOf,
} from '@/common/utils/stock-status';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductSort, QueryProductsDto } from './dto/query-products.dto';
import { CalculateQuantityDto } from './dto/calculate-quantity.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import {
  PRODUCTS_LIST_CACHE_PREFIX,
  productDetailCachePrefix,
  invalidateProductsCache,
} from './products-cache.util';

/** Two viewers only ever see two different shapes of a product (exact stock or not), so the cache only needs two buckets. */
const roleBucket = (role?: Role) => (canSeeExactStock(role) ? 'staff' : 'public');

/** Products change more often than collections (stock, price), so a shorter TTL than collections'. */
const CACHE_TTL_SECONDS = 60;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly orders: OrdersService,
    private readonly translation: TranslationService,
  ) {}

  /**
   * A product's `image` is either an absolute URL (seeded/external catalog
   * photos) or a bare blob path from `StorageService.uploadProductImage`
   * (e.g. "products/<uuid>.png") — the latter only ever resolves to a real
   * URL through `StorageService.getSignedUrl`, since the bucket behind it is
   * private with no public/listable access at all. See
   * `StorageService.resolveImageUrl` (shared with `AnalyticsService` so
   * every serializer resolves this the same way).
   */
  private resolveImageUrl(image: string): Promise<string> {
    return this.storage.resolveImageUrl(image);
  }

  private static readonly ORDER_BY: Record<ProductSort, Prisma.ProductOrderByWithRelationInput> = {
    [ProductSort.NEWEST]: { createdAt: 'desc' },
    [ProductSort.PRICE_ASC]: { price: 'asc' },
    [ProductSort.PRICE_DESC]: { price: 'desc' },
  };

  private async serialize(
    product: Prisma.ProductGetPayload<{ include: { collection: true } }>,
    threshold: number,
    viewerRole?: Role,
  ) {
    // quantityOnHandSqm/reservedAreaSqm/averageCostPrice are pulled out of
    // `rest` explicitly — they live directly on the Product row now, so
    // leaving them in `rest` would leak exact stock/cost to clients and the
    // public catalog.
    const { collection, quantityOnHandSqm, reservedAreaSqm, averageCostPrice, image, ...rest } =
      product;
    const onHandSqm = Number(quantityOnHandSqm);
    const reservedSqm = Number(reservedAreaSqm);
    const availableSqm = availableAreaSqmOf(onHandSqm, reservedSqm);
    const costPrice = Number(averageCostPrice);

    return {
      ...rest,
      image: await this.resolveImageUrl(image),
      // Product cards need the collection name as well as its denormalised
      // size. Keep the relation in the response so every catalog surface can
      // render the same metadata without making a second request.
      collection: {
        id: collection.id,
        title: collection.title,
        titleRw: collection.titleRw,
        slug: collection.slug,
        size: collection.size,
      },
      size: collection.size,
      tileAreaSqm: Number(collection.tileAreaSqm),
      // Reservations held by other customers' unpaid orders count against
      // this — see `availableAreaSqmOf`.
      stockStatus: stockStatusOf(availableSqm, threshold),
      ...(canSeeExactStock(viewerRole)
        ? {
            // Ground truth is m² — boxes/pieces alongside it are a display
            // conversion only, never re-stored. Floored, not the ceiling
            // `calculateTileQuantity` uses for "how much to buy": you can't
            // physically hold a partial piece, so any sliver of area smaller
            // than one tile just isn't a whole piece yet.
            quantityOnHandSqm: onHandSqm,
            reservedAreaSqm: reservedSqm,
            onHandBreakdown: piecesFromAreaSqm(onHandSqm, {
              tileAreaSqm: Number(collection.tileAreaSqm),
              boxCoverageSqm: Number(rest.boxCoverageSqm),
              piecesPerBox: rest.piecesPerBox,
            }),
            // Cost figures — never exposed to clients/public, same visibility as exact stock.
            averageCostPrice: costPrice,
            inventoryValue: onHandSqm * costPrice,
          }
        : {}),
    };
  }

  /**
   * Serialises products embedded in another module's response (favourites,
   * saved room designs) so a nested product carries the same signed image
   * URL, `size`, `tileAreaSqm` and `stockStatus` as one fetched straight from
   * `/products`, plus the nested `collection` (id/title/slug/size) the cart
   * lines already expose. Callers must load the product with its `collection`.
   */
  async serializeEmbedded(
    products: Prisma.ProductGetPayload<{ include: { collection: true } }>[],
    viewerRole?: Role,
  ) {
    const threshold = await getLowStockThreshold(this.prisma);
    return Promise.all(
      products.map(async (product) => ({
        ...(await this.serialize(product, threshold, viewerRole)),
        collection: {
          id: product.collection.id,
          title: product.collection.title,
          titleRw: product.collection.titleRw,
          slug: product.collection.slug,
          size: product.collection.size,
        },
      })),
    );
  }

  async findAll(query: QueryProductsDto, viewerRole?: Role) {
    const cacheKey =
      `${PRODUCTS_LIST_CACHE_PREFIX}${roleBucket(viewerRole)}:` +
      `page=${query.page}:limit=${query.limit}:collectionId=${query.collectionId ?? ''}:` +
      `size=${query.size ?? ''}:suitableFor=${query.suitableFor ?? ''}:` +
      `compatibleWith=${query.compatibleWith ?? ''}:` +
      `roomType=${query.roomType ?? ''}:search=${query.search ?? ''}:sort=${query.sort ?? ''}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      collectionId: query.collectionId,
      collection: query.size ? { size: query.size } : undefined,
      suitableFor: query.suitableFor,
      roomTypes: query.roomType ? { has: query.roomType } : undefined,
      AND: [
        query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { sku: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {},
        query.compatibleWith && query.compatibleWith !== SuitableFor.BOTH
          ? { suitableFor: { in: [query.compatibleWith, SuitableFor.BOTH] } }
          : query.compatibleWith === SuitableFor.BOTH
            ? { suitableFor: SuitableFor.BOTH }
            : {},
      ],
    };

    const [items, total, threshold] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { collection: true },
        skip: query.skip,
        take: query.limit,
        orderBy: ProductsService.ORDER_BY[query.sort ?? ProductSort.NEWEST],
      }),
      this.prisma.product.count({ where }),
      getLowStockThreshold(this.prisma),
    ]);

    const result = paginate(
      await Promise.all(items.map((item) => this.serialize(item, threshold, viewerRole))),
      total,
      query.page,
      query.limit,
    );
    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async findOne(id: string, viewerRole?: Role) {
    const cacheKey = `${productDetailCachePrefix(id)}${roleBucket(viewerRole)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const [product, threshold] = await Promise.all([
      this.prisma.product.findUnique({ where: { id }, include: { collection: true } }),
      getLowStockThreshold(this.prisma),
    ]);
    if (!product) throw notFound('catalog.productNotFound', 'Product not found.');

    const result = await this.serialize(product, threshold, viewerRole);
    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async create(dto: CreateProductDto, createdById?: string) {
    const initialAreaSqm = dto.initialAreaSqm ?? 0;
    // Cost is entered per m² now, same unit as `price` and as stock itself —
    // no more box/piece conversion needed to store it.
    const averageCostPrice =
      initialAreaSqm > 0 && dto.initialCostPrice !== undefined
        ? new Prisma.Decimal(dto.initialCostPrice)
        : new Prisma.Decimal(0);

    const translated = await this.translation.translateFields(
      { name: dto.name, description: dto.description },
      Language.EN,
      Language.RW,
    );

    const product = await this.withUniqueSkuCheck(() =>
      this.prisma.product.create({
        data: {
          name: dto.name,
          sku: dto.sku,
          slug: slugify(dto.name),
          collectionId: dto.collectionId,
          boxCoverageSqm: dto.boxCoverageSqm,
          piecesPerBox: dto.piecesPerBox,
          price: dto.price,
          image: dto.image,
          description: dto.description,
          nameRw: translated.name ?? null,
          descriptionRw: translated.description ?? null,
          suitableFor: dto.suitableFor,
          roomTypes: dto.roomTypes,
          quantityOnHandSqm: initialAreaSqm,
          averageCostPrice,
          // Audit trail for the opening stock, same feed every other movement writes to.
          ...(initialAreaSqm > 0
            ? {
                stockAdjustments: {
                  create: {
                    changeAreaSqm: initialAreaSqm,
                    type: StockMovementType.INBOUND,
                    reason: 'Initial stock on product creation',
                    costPrice: dto.initialCostPrice,
                    averageCostAfter: averageCostPrice,
                    adjustedById: createdById,
                  },
                },
              }
            : {}),
        },
        include: { collection: true },
      }),
    );
    await invalidateProductsCache(this.redis, [product.id]);
    return this.serialize(product, await getLowStockThreshold(this.prisma), Role.ADMIN);
  }

  /**
   * Wraps a create/update write that touches `sku` and turns the DB's unique
   * constraint violation into a clean 409 — a backstop for the rare race
   * where two submissions land between the live `checkSkuAvailability` poll
   * and the actual write, since that check alone can't be atomic with it.
   */
  private async withUniqueSkuCheck<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('products.skuInUse', 'This SKU is already in use by another product.');
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);

    // `name`/`description` are the always-English columns; `nameRw`/
    // `descriptionRw` the always-Kinyarwanda ones. The edit dialog sends
    // whichever pair matches the admin UI's current language — sending
    // `nameRw`/`descriptionRw` (and not `name`/`description`) means this
    // edit was authored in Kinyarwanda, so it's the *English* columns that
    // get regenerated here, not the usual other way round.
    const { name, description, nameRw, descriptionRw, ...rest } = dto;
    const editedInRw =
      (nameRw !== undefined || descriptionRw !== undefined) &&
      name === undefined &&
      description === undefined;

    // Only re-translates the fields actually being changed — `translateFields`
    // omits anything not passed, so an update that doesn't touch the edited
    // language's fields leaves the other language's columns alone.
    const translated = editedInRw
      ? await this.translation.translateFields(
          { name: nameRw, description: descriptionRw },
          Language.RW,
          Language.EN,
        )
      : await this.translation.translateFields({ name, description }, Language.EN, Language.RW);

    const finalName = editedInRw ? translated.name : name;
    const finalDescription = editedInRw ? translated.description : description;
    const finalNameRw = editedInRw ? nameRw : translated.name;
    const finalDescriptionRw = editedInRw ? descriptionRw : translated.description;

    const [product, threshold] = await Promise.all([
      this.withUniqueSkuCheck(() =>
        this.prisma.product.update({
          where: { id },
          data: {
            ...rest,
            name: finalName,
            description: finalDescription,
            slug: finalName ? slugify(finalName) : undefined,
            nameRw: finalNameRw,
            descriptionRw: finalDescriptionRw,
          },
          include: { collection: true },
        }),
      ),
      getLowStockThreshold(this.prisma),
    ]);
    await invalidateProductsCache(this.redis, [id]);
    return this.serialize(product, threshold, Role.ADMIN);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.product.update({ where: { id }, data: { isActive: false } });
    await invalidateProductsCache(this.redis, [id]);
  }

  /** Live check the registration/edit form polls (debounced) as the user types a SKU, so a collision surfaces before submit instead of after. Case-insensitive, since the DB's own unique index is the only place case ever matters for real. */
  async checkSkuAvailability(sku: string, excludeId?: string) {
    const trimmed = sku.trim();
    if (!trimmed) return { available: false };
    const existing = await this.prisma.product.findFirst({
      where: {
        sku: { equals: trimmed, mode: 'insensitive' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    return { available: !existing };
  }

  /** Price calculator from 3.3: client enters area, we return quantity + total price. */
  async calculateQuantity(dto: CalculateQuantityDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { collection: true },
    });
    if (!product) throw notFound('catalog.productNotFound', 'Product not found.');

    const quantity = calculateTileQuantity(dto.areaSqm, {
      tileAreaSqm: Number(product.collection.tileAreaSqm),
      boxCoverageSqm: Number(product.boxCoverageSqm),
      piecesPerBox: product.piecesPerBox,
    });

    // Priced by area, not by the box — see `orders.service.ts#create`.
    const totalPrice = quantity.purchasedArea * Number(product.price);

    return { ...quantity, unitPrice: Number(product.price), totalPrice };
  }

  async adjustStock(productId: string, dto: AdjustStockDto, adjustedById: string) {
    const exists = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!exists) throw notFound('catalog.productNotFound', 'Product not found.');

    if (dto.costPrice !== undefined && dto.changeAreaSqm <= 0) {
      throw badRequest(
        'products.costOnlyForIncoming',
        'A cost price only applies to stock coming in (changeAreaSqm must be positive).',
      );
    }

    const type =
      dto.type ?? (dto.changeAreaSqm >= 0 ? StockMovementType.INBOUND : StockMovementType.OUTBOUND);

    // Read, compute and write under one row lock: two adjustments at the same moment used to
    // both start from the same quantity, so both landed in the ledger while only one reached
    // the stock (and the average cost was computed from the wrong base). Now the second waits
    // for the first and works from what it left.
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const [current] = await tx.$queryRaw<
          { quantityOnHandSqm: Prisma.Decimal; averageCostPrice: Prisma.Decimal }[]
        >`SELECT "quantityOnHandSqm", "averageCostPrice" FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        if (!current) throw notFound('catalog.productNotFound', 'Product not found.');

        const nextQuantity = new Prisma.Decimal(current.quantityOnHandSqm).add(dto.changeAreaSqm);
        if (nextQuantity.isNegative()) {
          throw badRequest('products.negativeStock', 'Adjustment would result in negative stock.');
        }

        // Moving weighted-average cost — only recomputed when this batch's cost
        // is known; otherwise the average carries forward unchanged. Both sides
        // are already per-m², so no box/piece conversion is needed here anymore.
        let averageCostPrice = new Prisma.Decimal(current.averageCostPrice);
        if (dto.costPrice !== undefined) {
          const costPerSqm = new Prisma.Decimal(dto.costPrice);
          const oldTotalCost = averageCostPrice.mul(current.quantityOnHandSqm);
          const incomingTotalCost = costPerSqm.mul(dto.changeAreaSqm);
          // nextQuantity is > 0 here: changeAreaSqm > 0 (checked above) and the quantity on hand is >= 0.
          averageCostPrice = oldTotalCost.add(incomingTotalCost).div(nextQuantity);
        }

        const product = await tx.product.update({
          where: { id: productId },
          data: { quantityOnHandSqm: nextQuantity, averageCostPrice },
        });
        await tx.stockAdjustment.create({
          data: {
            productId,
            changeAreaSqm: dto.changeAreaSqm,
            type,
            reference: dto.reference,
            reason: dto.reason,
            adjustedById,
            costPrice: dto.costPrice,
            averageCostAfter: averageCostPrice,
          },
        });
        return product;
      },
      // Adjustments to one product queue behind its row lock — allow for a short queue.
      { maxWait: 15_000, timeout: 30_000 },
    );

    await invalidateProductsCache(this.redis, [productId]);
    await bestEffort('send the low-stock alert', () =>
      this.notifications.notifyLowStock([productId]),
    );
    // Stock coming in can be exactly what a waitlisted order (doc-driven
    // feature, no doc section number yet) was missing — a correction/damage
    // adjustment (negative changeAreaSqm) never frees anything, so skip it.
    if (dto.changeAreaSqm > 0) {
      await bestEffort('promote waitlisted orders', () =>
        this.orders.promoteWaitlistedOrders([productId]),
      );
    }
    return updated;
  }
}

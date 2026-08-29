import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, StockMovementType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { paginate } from '@/common/dto/pagination.dto';
import { slugify } from '@/common/utils/slugify';
import { calculateTileQuantity, piecesFromAreaSqm } from '@/common/utils/tile-calculator';
import { canSeeExactStock, getLowStockThreshold, stockStatusOf } from '@/common/utils/stock-status';
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
  ) {}

  private static readonly ORDER_BY: Record<ProductSort, Prisma.ProductOrderByWithRelationInput> = {
    [ProductSort.NEWEST]: { createdAt: 'desc' },
    [ProductSort.PRICE_ASC]: { price: 'asc' },
    [ProductSort.PRICE_DESC]: { price: 'desc' },
  };

  private serialize(
    product: Prisma.ProductGetPayload<{ include: { collection: true } }>,
    threshold: number,
    viewerRole?: Role,
  ) {
    // quantityOnHandSqm/averageCostPrice are pulled out of `rest` explicitly —
    // they live directly on the Product row now, so leaving them in `rest`
    // would leak exact stock/cost to clients and the public catalog.
    const { collection, quantityOnHandSqm, averageCostPrice, ...rest } = product;
    const onHandSqm = Number(quantityOnHandSqm);
    const costPrice = Number(averageCostPrice);

    return {
      ...rest,
      size: collection.size,
      tileAreaSqm: Number(collection.tileAreaSqm),
      stockStatus: stockStatusOf(onHandSqm, threshold),
      ...(canSeeExactStock(viewerRole)
        ? {
            // Ground truth is m² — boxes/pieces alongside it are a display
            // conversion only, never re-stored. Floored, not the ceiling
            // `calculateTileQuantity` uses for "how much to buy": you can't
            // physically hold a partial piece, so any sliver of area smaller
            // than one tile just isn't a whole piece yet.
            quantityOnHandSqm: onHandSqm,
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

  async findAll(query: QueryProductsDto, viewerRole?: Role) {
    const cacheKey =
      `${PRODUCTS_LIST_CACHE_PREFIX}${roleBucket(viewerRole)}:` +
      `page=${query.page}:limit=${query.limit}:collectionId=${query.collectionId ?? ''}:` +
      `size=${query.size ?? ''}:suitableFor=${query.suitableFor ?? ''}:` +
      `roomType=${query.roomType ?? ''}:search=${query.search ?? ''}:sort=${query.sort ?? ''}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      collectionId: query.collectionId,
      collection: query.size ? { size: query.size } : undefined,
      suitableFor: query.suitableFor,
      roomTypes: query.roomType ? { has: query.roomType } : undefined,
      name: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
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
      items.map((item) => this.serialize(item, threshold, viewerRole)),
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
    if (!product) throw new NotFoundException('Product not found.');

    const result = this.serialize(product, threshold, viewerRole);
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

    const product = await this.prisma.product.create({
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
    });
    await invalidateProductsCache(this.redis, [product.id]);
    return this.serialize(product, await getLowStockThreshold(this.prisma), Role.ADMIN);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    const [product, threshold] = await Promise.all([
      this.prisma.product.update({
        where: { id },
        data: { ...dto, slug: dto.name ? slugify(dto.name) : undefined },
        include: { collection: true },
      }),
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

  /** Price calculator from 3.3: client enters area, we return quantity + total price. */
  async calculateQuantity(dto: CalculateQuantityDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { collection: true },
    });
    if (!product) throw new NotFoundException('Product not found.');

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
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found.');

    const nextQuantity = new Prisma.Decimal(product.quantityOnHandSqm).add(dto.changeAreaSqm);
    if (nextQuantity.isNegative()) {
      throw new BadRequestException('Adjustment would result in negative stock.');
    }

    if (dto.costPrice !== undefined && dto.changeAreaSqm <= 0) {
      throw new BadRequestException(
        'A cost price only applies to stock coming in (changeAreaSqm must be positive).',
      );
    }

    const type =
      dto.type ?? (dto.changeAreaSqm >= 0 ? StockMovementType.INBOUND : StockMovementType.OUTBOUND);

    // Moving weighted-average cost — only recomputed when this batch's cost
    // is known; otherwise the average carries forward unchanged. Both sides
    // are already per-m², so no box/piece conversion is needed here anymore.
    let averageCostPrice = product.averageCostPrice;
    if (dto.costPrice !== undefined) {
      const costPerSqm = new Prisma.Decimal(dto.costPrice);
      const oldTotalCost = new Prisma.Decimal(product.averageCostPrice).mul(
        product.quantityOnHandSqm,
      );
      const incomingTotalCost = costPerSqm.mul(dto.changeAreaSqm);
      // nextQuantity is guaranteed > 0 here: changeAreaSqm > 0 (checked above) and quantityOnHandSqm >= 0.
      averageCostPrice = oldTotalCost.add(incomingTotalCost).div(nextQuantity);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.product.update({
        where: { id: productId },
        data: { quantityOnHandSqm: nextQuantity, averageCostPrice },
      }),
      this.prisma.stockAdjustment.create({
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
      }),
    ]);

    await invalidateProductsCache(this.redis, [productId]);
    await this.notifications.notifyLowStock([productId]);
    return updated;
  }
}

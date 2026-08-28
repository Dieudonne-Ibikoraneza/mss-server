import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, StockMovementType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { paginate } from '@/common/dto/pagination.dto';
import { slugify } from '@/common/utils/slugify';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';
import { stockStatusOf } from '@/common/utils/stock-status';
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

const canSeeExactStock = (role?: Role) =>
  role === Role.ADMIN ||
  role === Role.STOCK_MANAGER ||
  role === Role.SALES_PERSON ||
  role === Role.DATA_ANALYST;

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
    product: Prisma.ProductGetPayload<{ include: { inventory: true; collection: true } }>,
    viewerRole?: Role,
  ) {
    const quantityOnHand = product.inventory?.quantityOnHand ?? 0;
    const threshold = product.inventory?.lowStockThreshold ?? 20;
    const averageCostPrice = Number(product.inventory?.averageCostPrice ?? 0);
    const { inventory, collection, ...rest } = product;

    return {
      ...rest,
      size: collection.size,
      tileAreaSqm: Number(collection.tileAreaSqm),
      stockStatus: stockStatusOf(quantityOnHand, threshold),
      ...(canSeeExactStock(viewerRole)
        ? {
            quantityOnHand,
            reservedQuantity: inventory?.reservedQuantity ?? 0,
            // Cost figures — never exposed to clients/public, same visibility as exact stock.
            averageCostPrice,
            inventoryValue: quantityOnHand * averageCostPrice,
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

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { inventory: true, collection: true },
        skip: query.skip,
        take: query.limit,
        orderBy: ProductsService.ORDER_BY[query.sort ?? ProductSort.NEWEST],
      }),
      this.prisma.product.count({ where }),
    ]);

    const result = paginate(
      items.map((item) => this.serialize(item, viewerRole)),
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

    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { inventory: true, collection: true },
    });
    if (!product) throw new NotFoundException('Product not found.');

    const result = this.serialize(product, viewerRole);
    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async create(dto: CreateProductDto, createdById?: string) {
    const initialQuantity = dto.initialQuantity ?? 0;
    // Cost is entered per box (mirrors `price`), stored per piece to line up
    // with quantities that are always tracked in pieces.
    const averageCostPrice =
      initialQuantity > 0 && dto.initialCostPrice !== undefined
        ? new Prisma.Decimal(dto.initialCostPrice).div(dto.piecesPerBox)
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
        inventory: {
          create: {
            quantityOnHand: initialQuantity,
            lowStockThreshold: dto.lowStockThreshold ?? 20,
            averageCostPrice,
          },
        },
        // Audit trail for the opening stock, same feed every other movement writes to.
        ...(initialQuantity > 0
          ? {
              stockAdjustments: {
                create: {
                  changeQty: initialQuantity,
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
      include: { inventory: true, collection: true },
    });
    await invalidateProductsCache(this.redis, [product.id]);
    return this.serialize(product, Role.ADMIN);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    const product = await this.prisma.product.update({
      where: { id },
      data: { ...dto, slug: dto.name ? slugify(dto.name) : undefined },
      include: { inventory: true, collection: true },
    });
    await invalidateProductsCache(this.redis, [id]);
    return this.serialize(product, Role.ADMIN);
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

    const totalPrice = quantity.totalPieces * (Number(product.price) / product.piecesPerBox);

    return { ...quantity, unitPrice: Number(product.price), totalPrice };
  }

  async adjustStock(productId: string, dto: AdjustStockDto, adjustedById: string) {
    const inventory = await this.prisma.inventory.findUnique({ where: { productId } });
    if (!inventory) throw new NotFoundException('Product has no inventory record.');

    const nextQuantity = inventory.quantityOnHand + dto.changeQty;
    if (nextQuantity < 0) {
      throw new BadRequestException('Adjustment would result in negative stock.');
    }

    if (dto.costPrice !== undefined && dto.changeQty <= 0) {
      throw new BadRequestException(
        'A cost price only applies to stock coming in (changeQty must be positive).',
      );
    }

    const type =
      dto.type ?? (dto.changeQty >= 0 ? StockMovementType.INBOUND : StockMovementType.OUTBOUND);

    // Moving weighted-average cost — only recomputed when this batch's cost
    // is known; otherwise the average carries forward unchanged.
    let averageCostPrice = inventory.averageCostPrice;
    if (dto.costPrice !== undefined) {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { piecesPerBox: true },
      });
      if (!product) throw new NotFoundException('Product not found.');

      const costPerPiece = new Prisma.Decimal(dto.costPrice).div(product.piecesPerBox);
      const oldTotalCost = new Prisma.Decimal(inventory.averageCostPrice).mul(
        inventory.quantityOnHand,
      );
      const incomingTotalCost = costPerPiece.mul(dto.changeQty);
      // nextQuantity is guaranteed > 0 here: changeQty > 0 (checked above) and quantityOnHand >= 0.
      averageCostPrice = oldTotalCost.add(incomingTotalCost).div(nextQuantity);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.inventory.update({
        where: { productId },
        data: { quantityOnHand: nextQuantity, averageCostPrice },
      }),
      this.prisma.stockAdjustment.create({
        data: {
          productId,
          changeQty: dto.changeQty,
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

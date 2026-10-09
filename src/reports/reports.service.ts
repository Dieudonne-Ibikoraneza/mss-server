import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StorageService } from '@/storage/storage.service';
import { paginate } from '@/common/dto/pagination.dto';
import {
  AnalyticsPeriod,
  bucketize,
  resolvePeriod,
  type ResolvedPeriod,
} from '@/common/utils/analytics-period';
import { getLowStockThreshold, stockStatusOf } from '@/common/utils/stock-status';
import { QueryMovementsDto } from './dto/query-movements.dto';
import { badRequest, notFound } from '@/common/errors/app-error';
import { QueryStockExportDto } from './dto/query-stock-export.dto';
import { resolveStockExportPeriod } from './stock-export-period';

/**
 * "Generate stock reports" (doc 3.10/3.11, stock manager) — stock movements,
 * low stock, and the fulfilment queue. The rest of the stock reports page
 * (sales overview, AI performance, repeat purchase rate, conversion journey)
 * now lives directly under `/analytics/*`, which `STOCK_MANAGER` can reach
 * too — see `analytics.controller.ts`. Nothing here needs to delegate to
 * `AnalyticsService` any more.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async stockSummary(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    return this.stockSummaryForPeriod(resolvePeriod(period));
  }

  private async stockSummaryForPeriod(
    resolved: ResolvedPeriod,
    productId?: string,
    inventory?: { quantityOnHandSqm: number; averageCostPrice: number; isActive: boolean }[],
    collectionId?: string,
  ) {
    const [movements, products, lowStockThreshold] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where: {
          createdAt: { gte: resolved.from, lt: resolved.to },
          productId,
          ...(collectionId ? { product: { collectionId } } : {}),
        },
        select: { changeAreaSqm: true, type: true, createdAt: true },
      }),
      inventory ??
        this.prisma.product.findMany({
          where: this.productScope(productId, collectionId),
          select: { quantityOnHandSqm: true, averageCostPrice: true, isActive: true },
        }),
      getLowStockThreshold(this.prisma),
    ]);

    const sum = (predicate: (row: (typeof movements)[number]) => boolean) =>
      movements.filter(predicate).reduce((total, row) => total + Number(row.changeAreaSqm), 0);

    const totalInbound = sum((row) => Number(row.changeAreaSqm) > 0);
    const totalOutbound = sum((row) => Number(row.changeAreaSqm) < 0);

    // Valued at cost (average purchase price), never at the selling price.
    const inventoryValue = products.reduce(
      (total, row) => total + Number(row.quantityOnHandSqm) * Number(row.averageCostPrice),
      0,
    );

    return {
      period: resolved.period,
      from: resolved.from,
      to: resolved.to,
      totalInbound,
      /** Reported as a negative number, matching the signed quantities in the feed. */
      totalOutbound,
      netChange: totalInbound + totalOutbound,
      activeProducts: products.filter((row) => row.isActive !== false).length,
      lowStockItems: products.filter((row) => {
        const onHand = Number(row.quantityOnHandSqm);
        return onHand > 0 && onHand <= lowStockThreshold;
      }).length,
      outOfStockItems: products.filter((row) => Number(row.quantityOnHandSqm) === 0).length,
      totalInventoryValue: inventoryValue,
      trend: bucketize(
        movements,
        resolved,
        (row) => row.createdAt,
        (row) => Number(row.changeAreaSqm),
      ),
      byType: Object.values(StockMovementType).map((type) => ({
        type,
        movements: movements.filter((row) => row.type === type).length,
        areaSqm: sum((row) => row.type === type),
      })),
    };
  }

  async stockMovements(query: QueryMovementsDto) {
    const resolved = resolvePeriod(query.period);
    const where: Prisma.StockAdjustmentWhereInput = {
      createdAt: { gte: resolved.from, lt: resolved.to },
      type: query.type,
      productId: query.productId,
    };

    const [items, total] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, sku: true } },
          adjustedBy: { select: { id: true, fullName: true } },
        },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.stockAdjustment.count({ where }),
    ]);

    return paginate(items, total, query.page, query.limit);
  }

  private movementRowsForExport(query: QueryStockExportDto, resolved: ResolvedPeriod) {
    return this.prisma.stockAdjustment.findMany({
      where: {
        createdAt: { gte: resolved.from, lt: resolved.to },
        type: query.type,
        productId: query.productId,
        ...(query.collectionId ? { product: { collectionId: query.collectionId } } : {}),
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        adjustedBy: { select: { id: true, fullName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** Lightweight choices include inactive tiles so their remaining stock can be reported. */
  stockExportTiles() {
    return this.prisma.product
      .findMany({
        select: {
          id: true,
          name: true,
          sku: true,
          isActive: true,
          image: true,
          roomTypes: true,
          suitableFor: true,
          quantityOnHandSqm: true,
          collection: { select: { id: true, title: true, size: true, isActive: true } },
        },
        orderBy: [{ name: 'asc' }, { sku: 'asc' }],
      })
      .then(async (rows) => {
        const threshold = await getLowStockThreshold(this.prisma);
        return Promise.all(
          rows.map(async (tile) => ({
            ...tile,
            image: tile.image ? await this.storage.resolveImageUrl(tile.image) : null,
            quantityOnHandSqm: Number(tile.quantityOnHandSqm),
            stockStatus: stockStatusOf(Number(tile.quantityOnHandSqm), threshold),
            size: tile.collection.size,
          })),
        );
      });
  }

  stockExportCollections() {
    return this.prisma.collection
      .findMany({
        select: {
          id: true,
          title: true,
          size: true,
          isActive: true,
          _count: { select: { products: true } },
        },
        orderBy: { title: 'asc' },
      })
      .then((rows) =>
        rows.map(({ _count, ...row }) => ({ ...row, productCount: _count.products })),
      );
  }

  private productScope(productId?: string, collectionId?: string): Prisma.ProductWhereInput {
    return productId ? { id: productId } : collectionId ? { collectionId } : { isActive: true };
  }

  private async selectedCollection(query: QueryStockExportDto) {
    if (query.productId && query.collectionId)
      throw badRequest('reports.conflictingScope', 'Choose either a tile or a collection.');
    if (!query.collectionId) return null;
    const row = await this.prisma.collection.findUnique({
      where: { id: query.collectionId },
      select: {
        id: true,
        title: true,
        size: true,
        isActive: true,
        _count: { select: { products: true } },
      },
    });
    if (!row)
      throw notFound('reports.collectionNotFound', 'The selected collection was not found.');
    const { _count, ...collection } = row;
    return { ...collection, productCount: _count.products };
  }

  private async currentStockValuation(productId?: string, collectionId?: string) {
    const rows = await this.prisma.product.findMany({
      where: this.productScope(productId, collectionId),
      select: {
        id: true,
        name: true,
        sku: true,
        isActive: true,
        quantityOnHandSqm: true,
        averageCostPrice: true,
        collection: { select: { size: true } },
      },
      orderBy: [{ name: 'asc' }, { sku: 'asc' }],
    });
    if (productId && rows.length === 0)
      throw notFound('reports.tileNotFound', 'The selected tile was not found.');
    return rows.map((row) => {
      const quantityOnHandSqm = Number(row.quantityOnHandSqm);
      const averageCostPrice = Number(row.averageCostPrice);
      return {
        productId: row.id,
        name: row.name,
        sku: row.sku,
        size: row.collection.size,
        isActive: row.isActive,
        quantityOnHandSqm,
        averageCostPrice,
        inventoryValue: quantityOnHandSqm * averageCostPrice,
      };
    });
  }

  private selectedTile(
    productId: string | undefined,
    valuation: Awaited<ReturnType<ReportsService['currentStockValuation']>>,
  ) {
    const row = productId ? valuation[0] : undefined;
    return row
      ? { id: row.productId, name: row.name, sku: row.sku, size: row.size, isActive: row.isActive }
      : null;
  }

  /** One complete read of the selected journal, independent of the visible page. */
  async stockMovementsExport(query: QueryStockExportDto) {
    const generatedAt = new Date();
    const resolved = resolveStockExportPeriod(query, generatedAt);
    const collection = await this.selectedCollection(query);
    const valuation = await this.currentStockValuation(query.productId, query.collectionId);
    return {
      generatedAt,
      period: resolved.period,
      from: resolved.from,
      to: resolved.to,
      movementType: query.type ?? 'ALL',
      tile: this.selectedTile(query.productId, valuation),
      collection,
      valuation,
      items: await this.movementRowsForExport(query, resolved),
    };
  }

  /** Inventory and fulfilment are current; movement totals use one captured reporting window. */
  async stockReportExport(query: QueryStockExportDto) {
    const generatedAt = new Date();
    const resolved = resolveStockExportPeriod(query, generatedAt);
    const collection = await this.selectedCollection(query);
    const valuation = await this.currentStockValuation(query.productId, query.collectionId);
    const [summary, movements, lowStock, fulfillment] = await Promise.all([
      this.stockSummaryForPeriod(resolved, query.productId, valuation, query.collectionId),
      this.movementRowsForExport(query, resolved),
      this.lowStock(null, query.productId, query.collectionId),
      this.fulfillmentQueue(null, query.productId, query.collectionId),
    ]);
    return {
      generatedAt,
      period: resolved.period,
      from: resolved.from,
      to: resolved.to,
      movementType: query.type ?? 'ALL',
      tile: this.selectedTile(query.productId, valuation),
      collection,
      valuation,
      summary,
      movements,
      lowStock,
      fulfillment,
    };
  }

  /** The alert list the stock overview leads with: what needs restocking, worst first. */
  async lowStock(limit: number | null = 20, productId?: string, collectionId?: string) {
    const [products, lowStockThreshold] = await Promise.all([
      this.prisma.product.findMany({
        where: this.productScope(productId, collectionId),
        select: {
          id: true,
          name: true,
          sku: true,
          image: true,
          quantityOnHandSqm: true,
          price: true,
          updatedAt: true,
          collection: { select: { size: true } },
        },
      }),
      getLowStockThreshold(this.prisma),
    ]);

    const worst = products
      .map((row) => ({ ...row, quantityOnHandSqm: Number(row.quantityOnHandSqm) }))
      .filter((row) => row.quantityOnHandSqm <= lowStockThreshold)
      .sort((a, b) => a.quantityOnHandSqm - b.quantityOnHandSqm)
      .slice(0, limit ?? products.length);

    // A product's stored `image` is a bare private-bucket path for anything
    // uploaded through the app — resolve it (only for the rows actually
    // returned) to a URL a client can load, like every other endpoint that
    // echoes one does, instead of forwarding the raw value.
    return Promise.all(
      worst.map(async (row) => ({
        productId: row.id,
        name: row.name,
        sku: row.sku,
        image: await this.storage.resolveImageUrl(row.image),
        size: row.collection.size,
        price: Number(row.price),
        updatedAt: row.updatedAt,
        quantityOnHandSqm: row.quantityOnHandSqm,
        lowStockThreshold,
        stockStatus: stockStatusOf(row.quantityOnHandSqm, lowStockThreshold),
      })),
    );
  }

  /** Orders the warehouse still has to act on, for the stock overview's fulfilment queue. */
  async fulfillmentQueue(limit: number | null = 20, productId?: string, collectionId?: string) {
    const pendingStatuses: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.PROCESSING,
      OrderStatus.READY_FOR_DISPATCH,
    ];
    const where: Prisma.OrderWhereInput = {
      status: { in: pendingStatuses },
      ...(productId || collectionId
        ? { items: { some: { ...(productId ? { productId } : { product: { collectionId } }) } } }
        : {}),
    };

    const [orders, counts] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          customer: { select: { id: true, fullName: true } },
          items: {
            where: productId
              ? { productId }
              : collectionId
                ? { product: { collectionId } }
                : undefined,
            select: { totalPieces: true },
          },
          delivery: true,
        },
        orderBy: { createdAt: 'asc' },
        take: limit ?? undefined,
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
    ]);

    return {
      byStatus: pendingStatuses.map((status) => ({
        status,
        count: counts.find((row) => row.status === status)?._count._all ?? 0,
      })),
      orders,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { paginate } from '@/common/dto/pagination.dto';
import { AnalyticsPeriod, bucketize, resolvePeriod } from '@/common/utils/analytics-period';
import { getLowStockThreshold, stockStatusOf } from '@/common/utils/stock-status';
import { QueryMovementsDto } from './dto/query-movements.dto';

/**
 * "Generate stock reports" (doc 3.11, stock manager). Everything here reads from
 * the StockAdjustment feed, which every path that moves stock writes to — manual
 * adjustments as well as the automatic outbound movement when an order is
 * delivered — so a single query answers "what moved, when, and who moved it".
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async stockSummary(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [movements, products, lowStockThreshold] = await Promise.all([
      this.prisma.stockAdjustment.findMany({
        where: { createdAt: { gte: resolved.from, lt: resolved.to } },
        select: { changeAreaSqm: true, type: true, createdAt: true },
      }),
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { quantityOnHandSqm: true, averageCostPrice: true },
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
      activeProducts: products.length,
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

  /** The alert list the stock overview leads with: what needs restocking, worst first. */
  async lowStock(limit = 20) {
    const [products, lowStockThreshold] = await Promise.all([
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true, sku: true, image: true, quantityOnHandSqm: true },
      }),
      getLowStockThreshold(this.prisma),
    ]);

    return products
      .map((row) => ({ ...row, quantityOnHandSqm: Number(row.quantityOnHandSqm) }))
      .filter((row) => row.quantityOnHandSqm <= lowStockThreshold)
      .sort((a, b) => a.quantityOnHandSqm - b.quantityOnHandSqm)
      .slice(0, limit)
      .map((row) => ({
        productId: row.id,
        name: row.name,
        sku: row.sku,
        image: row.image,
        quantityOnHandSqm: row.quantityOnHandSqm,
        lowStockThreshold,
        stockStatus: stockStatusOf(row.quantityOnHandSqm, lowStockThreshold),
      }));
  }

  /** Orders the warehouse still has to act on, for the stock overview's fulfilment queue. */
  async fulfillmentQueue(limit = 20) {
    const pendingStatuses: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.PROCESSING,
      OrderStatus.READY_FOR_DISPATCH,
    ];

    const [orders, counts] = await Promise.all([
      this.prisma.order.findMany({
        where: { status: { in: pendingStatuses } },
        include: {
          customer: { select: { id: true, fullName: true } },
          items: { select: { totalPieces: true } },
          delivery: true,
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { status: { in: pendingStatuses } },
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

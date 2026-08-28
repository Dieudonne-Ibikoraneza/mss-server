import { Injectable } from '@nestjs/common';
import {
  JourneyStage,
  OrderStatus,
  Prisma,
  RoomType,
  TileEventType,
  type Product,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { paginate } from '@/common/dto/pagination.dto';
import { AnalyticsPeriod, bucketize, resolvePeriod } from '@/common/utils/analytics-period';
import { QueryAnalyticsDto, QueryAnalyticsTableDto } from './dto/query-analytics.dto';

const JOURNEY_ORDER: JourneyStage[] = [
  JourneyStage.OPENED_SYSTEM,
  JourneyStage.CREATED_ROOM,
  JourneyStage.ENTERED_DIMENSIONS,
  JourneyStage.VIEWED_TILE,
  JourneyStage.APPLIED_TILE,
  JourneyStage.SAVED_DESIGN,
  JourneyStage.REQUESTED_QUOTATION,
  JourneyStage.NEGOTIATED,
  JourneyStage.PLACED_ORDER,
  JourneyStage.PURCHASED,
];

/** Orders that represent money actually earned, for every revenue figure below. */
const EARNED_STATUSES: OrderStatus[] = [OrderStatus.SHIPPED, OrderStatus.DELIVERED];

const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Cross-dashboard overview --------------------------------------------

  /** The KPI strip the admin and analyst overview screens lead with. */
  async overview(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [
      earnedOrders,
      totalOrders,
      pendingOrders,
      totalCustomers,
      repeatCustomers,
      recommendations,
      inventories,
      funnel,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: { status: { in: EARNED_STATUSES } },
        select: { total: true, createdAt: true },
      }),
      this.prisma.order.count(),
      this.prisma.order.count({
        where: {
          status: {
            in: [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.READY_FOR_DISPATCH],
          },
        },
      }),
      this.prisma.user.count({ where: { role: 'CLIENT' } }),
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: { status: { not: OrderStatus.CANCELLED } },
        _count: { _all: true },
        having: { customerId: { _count: { gt: 1 } } },
      }),
      this.prisma.recommendation.findMany({
        select: { decision: true, purchased: true, matchScore: true },
      }),
      this.prisma.inventory.findMany({
        where: { product: { isActive: true } },
      }),
      this.conversionFunnel(),
    ]);

    const totalSales = earnedOrders.reduce((sum, order) => sum + Number(order.total), 0);
    const accepted = recommendations.filter((row) => row.decision === 'ACCEPTED').length;

    return {
      period: resolved.period,
      totalSales,
      totalOrders,
      pendingOrders,
      averageOrderValue: earnedOrders.length ? totalSales / earnedOrders.length : 0,
      totalCustomers,
      repeatCustomers: repeatCustomers.length,
      repeatPurchaseRate: percent(repeatCustomers.length, totalCustomers),
      totalRecommendations: recommendations.length,
      recommendationAcceptanceRate: percent(accepted, recommendations.length),
      averageMatchScore: recommendations.length
        ? recommendations.reduce((sum, row) => sum + Number(row.matchScore), 0) /
          recommendations.length
        : 0,
      activeProducts: inventories.length,
      lowStockItems: inventories.filter(
        (row) => row.quantityOnHand > 0 && row.quantityOnHand <= row.lowStockThreshold,
      ).length,
      outOfStockItems: inventories.filter((row) => row.quantityOnHand === 0).length,
      // Valued at cost (average purchase price), never at the selling price.
      totalInventoryValue: inventories.reduce(
        (total, row) => total + row.quantityOnHand * Number(row.averageCostPrice),
        0,
      ),
      revenueTrend: bucketize(
        earnedOrders,
        resolved,
        (order) => order.createdAt,
        (order) => Number(order.total),
      ),
      funnel,
    };
  }

  // --- 3.9 Customer profile analytics -------------------------------------

  async customerAnalytics(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [clients, byHeardAboutUs, repeatCustomers, projectTypes] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'CLIENT' },
        select: { id: true, createdAt: true, status: true },
      }),
      this.prisma.user.groupBy({
        by: ['heardAboutUs'],
        where: { role: 'CLIENT' },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: { status: { not: OrderStatus.CANCELLED } },
        _count: { _all: true },
        having: { customerId: { _count: { gt: 1 } } },
      }),
      this.projectTypeDistribution(),
    ]);

    const repeatIds = new Set(repeatCustomers.map((row) => row.customerId));

    return {
      period: resolved.period,
      totalCustomers: clients.length,
      activeCustomers: clients.filter((row) => row.status === 'ACTIVE').length,
      newCustomers: clients.filter(
        (row) => row.createdAt >= resolved.from && row.createdAt < resolved.to,
      ).length,
      repeatCustomerCount: repeatIds.size,
      repeatPurchaseRate: percent(repeatIds.size, clients.length),
      byHeardAboutUs: byHeardAboutUs.map((row) => ({
        source: row.heardAboutUs,
        count: row._count._all,
      })),
      projectTypes,
      trend: {
        newCustomers: bucketize(clients, resolved, (row) => row.createdAt),
      },
    };
  }

  /**
   * "Project types" on the dashboards means the room types customers are buying
   * for. A product can suit several rooms, so each order line's customers and
   * revenue are split evenly across its room types — that way the slices add up
   * to the totals instead of double counting.
   */
  private async projectTypeDistribution() {
    const items = await this.prisma.orderItem.findMany({
      include: {
        product: { select: { roomTypes: true } },
        order: { select: { customerId: true, total: true, status: true } },
      },
    });

    const customers = new Map<RoomType, Set<string>>();
    const revenue = new Map<RoomType, number>();

    for (const item of items) {
      const roomTypes = item.product.roomTypes;
      if (roomTypes.length === 0) continue;
      const share = Number(item.totalPrice) / roomTypes.length;

      for (const roomType of roomTypes) {
        if (!customers.has(roomType)) customers.set(roomType, new Set());
        customers.get(roomType)!.add(item.order.customerId);
        if (EARNED_STATUSES.includes(item.order.status)) {
          revenue.set(roomType, (revenue.get(roomType) ?? 0) + share);
        }
      }
    }

    return Object.values(RoomType).map((roomType) => ({
      roomType,
      customers: customers.get(roomType)?.size ?? 0,
      revenue: revenue.get(roomType) ?? 0,
    }));
  }

  // --- 3.9 Tile interaction analytics -------------------------------------

  async tileInteractionAnalytics(limit = 10) {
    const countByType = async (type: TileEventType) =>
      this.prisma.tileEvent.groupBy({
        by: ['productId'],
        where: { type },
        _count: { _all: true },
        orderBy: { _count: { productId: 'desc' } },
        take: limit,
      });

    const [viewed, applied, compared, saved, purchased] = await Promise.all([
      countByType(TileEventType.VIEWED),
      countByType(TileEventType.APPLIED),
      countByType(TileEventType.COMPARED),
      countByType(TileEventType.SAVED),
      countByType(TileEventType.PURCHASED),
    ]);

    const productIds = [
      ...new Set(
        [...viewed, ...applied, ...compared, ...saved, ...purchased].map((r) => r.productId),
      ),
    ];
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const productName = (id: string) => products.find((p) => p.id === id)?.name ?? 'Unknown';

    const attach = (rows: { productId: string; _count: { _all: number } }[]) =>
      rows.map((row) => ({
        productId: row.productId,
        name: productName(row.productId),
        count: row._count._all,
      }));

    return {
      mostViewed: attach(viewed),
      mostApplied: attach(applied),
      mostCompared: attach(compared),
      mostSaved: attach(saved),
      mostPurchased: attach(purchased),
    };
  }

  /**
   * Per-tile interaction table with the two documented rates on every row, plus
   * the platform averages the summary cards show. Paginated and searchable to
   * match the tiles dashboard's product table.
   */
  async tilePerformanceTable(query: QueryAnalyticsTableDto) {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { sku: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [products, total, events] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { inventory: true, collection: { select: { title: true, size: true } } },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
      this.prisma.tileEvent.groupBy({ by: ['productId', 'type'], _count: { _all: true } }),
    ]);

    const countOf = (productId: string, type: TileEventType) =>
      events.find((row) => row.productId === productId && row.type === type)?._count._all ?? 0;

    const rows = products.map((product) => {
      const viewed = countOf(product.id, TileEventType.VIEWED);
      const applied = countOf(product.id, TileEventType.APPLIED);
      const purchased = countOf(product.id, TileEventType.PURCHASED);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        image: product.image,
        collection: product.collection.title,
        size: product.collection.size,
        quantityOnHand: product.inventory?.quantityOnHand ?? 0,
        lowStockThreshold: product.inventory?.lowStockThreshold ?? 20,
        viewed,
        applied,
        compared: countOf(product.id, TileEventType.COMPARED),
        saved: countOf(product.id, TileEventType.SAVED),
        purchased,
        selectionRate: percent(applied, viewed),
        purchaseConversion: percent(purchased, viewed),
      };
    });

    const totals = events.reduce(
      (acc, row) => {
        if (row.type === TileEventType.VIEWED) acc.viewed += row._count._all;
        if (row.type === TileEventType.APPLIED) acc.applied += row._count._all;
        if (row.type === TileEventType.PURCHASED) acc.purchased += row._count._all;
        return acc;
      },
      { viewed: 0, applied: 0, purchased: 0 },
    );

    return {
      ...paginate(rows, total, query.page, query.limit),
      summary: {
        averageSelectionRate: percent(totals.applied, totals.viewed),
        averagePurchaseConversion: percent(totals.purchased, totals.viewed),
        totalViews: totals.viewed,
      },
    };
  }

  /** Tile selection rate = applied / viewed * 100; purchase conversion = purchased / viewed * 100. */
  async tileRates(productId: string) {
    const [viewed, applied, purchased] = await Promise.all([
      this.prisma.tileEvent.count({ where: { productId, type: TileEventType.VIEWED } }),
      this.prisma.tileEvent.count({ where: { productId, type: TileEventType.APPLIED } }),
      this.prisma.tileEvent.count({ where: { productId, type: TileEventType.PURCHASED } }),
    ]);

    return {
      productId,
      viewed,
      applied,
      purchased,
      selectionRate: percent(applied, viewed),
      purchaseConversion: percent(purchased, viewed),
    };
  }

  // --- Customer journey / conversion funnel -------------------------------

  async conversionFunnel() {
    const counts = await Promise.all(
      JOURNEY_ORDER.map((stage) =>
        this.prisma.customerJourneyEvent
          .findMany({ where: { stage }, distinct: ['sessionId'], select: { sessionId: true } })
          .then((rows) => rows.length),
      ),
    );

    return JOURNEY_ORDER.map((stage, index) => ({ stage, customers: counts[index] }));
  }

  /**
   * The funnel plus, for each stage, how many customers were lost against the
   * previous stage and what share of the very first stage survives to it —
   * the two numbers the journey dashboard puts next to every step.
   */
  async journeyAnalytics(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [funnel, events] = await Promise.all([
      this.conversionFunnel(),
      this.prisma.customerJourneyEvent.findMany({
        where: { createdAt: { gte: resolved.from, lt: resolved.to } },
        select: { createdAt: true, sessionId: true, stage: true },
      }),
    ]);

    const entry = funnel[0]?.customers ?? 0;
    const stages = funnel.map((row, index) => {
      const previous = index === 0 ? row.customers : funnel[index - 1].customers;
      return {
        ...row,
        conversionFromPrevious: percent(row.customers, previous),
        dropOffFromPrevious: previous - row.customers,
        dropOffRate: previous ? percent(previous - row.customers, previous) : 0,
        shareOfEntry: percent(row.customers, entry),
      };
    });

    const sessions = new Set(events.map((row) => row.sessionId));
    const purchased = funnel.find((row) => row.stage === JourneyStage.PURCHASED)?.customers ?? 0;

    return {
      period: resolved.period,
      stages,
      totalSessions: sessions.size,
      overallConversionRate: percent(purchased, entry),
      trend: bucketize(events, resolved, (row) => row.createdAt),
    };
  }

  // --- Sales analytics -----------------------------------------------------

  async salesAnalytics(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [earnedOrders, byStatus, bestSelling, projectTypes] = await Promise.all([
      this.prisma.order.findMany({
        where: { status: { in: EARNED_STATUSES } },
        select: { total: true, createdAt: true, createdByType: true },
      }),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true }, _sum: { total: true } }),
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        _sum: { totalPrice: true, totalPieces: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 10,
      }),
      this.projectTypeDistribution(),
    ]);

    const productIds = bestSelling.map((row) => row.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const totalSales = earnedOrders.reduce((sum, order) => sum + Number(order.total), 0);

    const bestSellingTiles = bestSelling.map((row) => {
      const product = products.find((p: Product) => p.id === row.productId);
      return {
        productId: row.productId,
        name: product?.name ?? 'Unknown',
        image: product?.image ?? null,
        revenue: Number(row._sum.totalPrice ?? 0),
        pieces: row._sum.totalPieces ?? 0,
      };
    });

    return {
      period: resolved.period,
      totalSales,
      totalOrders: earnedOrders.length,
      averageOrderValue: earnedOrders.length ? totalSales / earnedOrders.length : 0,
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
        total: Number(row._sum.total ?? 0),
      })),
      byCreator: (['CUSTOMER', 'STAFF'] as const).map((createdByType) => ({
        createdByType,
        count: earnedOrders.filter((order) => order.createdByType === createdByType).length,
        total: earnedOrders
          .filter((order) => order.createdByType === createdByType)
          .reduce((sum, order) => sum + Number(order.total), 0),
      })),
      /** Revenue per room type — "sales by project type" in the doc. */
      byProjectType: projectTypes.map((row) => ({ roomType: row.roomType, revenue: row.revenue })),
      bestSellingTiles,
      topPerformer: bestSellingTiles[0] ?? null,
      revenueTrend: bucketize(
        earnedOrders,
        resolved,
        (order) => order.createdAt,
        (order) => Number(order.total),
      ),
    };
  }

  // --- AI recommendation performance ---------------------------------------

  async recommendationPerformance(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);
    const rows = await this.prisma.recommendation.findMany({
      select: { decision: true, purchased: true, matchScore: true, createdAt: true },
    });

    const accepted = rows.filter((row) => row.decision === 'ACCEPTED').length;
    const rejected = rows.filter((row) => row.decision === 'REJECTED').length;
    const purchased = rows.filter((row) => row.purchased).length;

    return {
      period: resolved.period,
      displayed: rows.length,
      accepted,
      rejected,
      purchased,
      acceptanceRate: percent(accepted, rows.length),
      purchaseRate: percent(purchased, rows.length),
      averageMatchScore: rows.length
        ? rows.reduce((sum, row) => sum + Number(row.matchScore), 0) / rows.length
        : 0,
      trend: bucketize(rows, resolved, (row) => row.createdAt),
    };
  }

  /** Per-tile recommendation performance, for the AI dashboard's product table. */
  async recommendationTable(query: QueryAnalyticsTableDto) {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { sku: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [products, total, grouped] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { inventory: true, collection: { select: { title: true, size: true } } },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
      this.prisma.recommendation.groupBy({
        by: ['productId', 'decision'],
        _count: { _all: true },
        _avg: { matchScore: true },
      }),
    ]);

    const rows = products.map((product) => {
      const forProduct = grouped.filter((row) => row.productId === product.id);
      const displayed = forProduct.reduce((sum, row) => sum + row._count._all, 0);
      const accepted = forProduct.find((row) => row.decision === 'ACCEPTED')?._count._all ?? 0;
      const scores = forProduct.filter((row) => row._avg.matchScore !== null);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        image: product.image,
        collection: product.collection.title,
        size: product.collection.size,
        quantityOnHand: product.inventory?.quantityOnHand ?? 0,
        lowStockThreshold: product.inventory?.lowStockThreshold ?? 20,
        displayed,
        accepted,
        acceptanceRate: percent(accepted, displayed),
        averageMatchScore: scores.length
          ? scores.reduce((sum, row) => sum + Number(row._avg.matchScore), 0) / scores.length
          : 0,
      };
    });

    return paginate(rows, total, query.page, query.limit);
  }

  // --- Marketing analysis ---------------------------------------------------

  async marketingAnalysis(query: QueryAnalyticsDto = {}) {
    const resolved = resolvePeriod(query.period);
    const [rows, clients] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['heardAboutUs'],
        where: { role: 'CLIENT' },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: { role: 'CLIENT' },
        select: { heardAboutUs: true, createdAt: true },
      }),
    ]);

    return {
      period: resolved.period,
      bySource: rows.map((row) => ({ source: row.heardAboutUs, count: row._count._all })),
      trend: bucketize(clients, resolved, (row) => row.createdAt),
    };
  }
}

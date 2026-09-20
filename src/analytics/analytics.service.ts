import { Injectable } from '@nestjs/common';
import {
  HearAboutUs,
  JourneyStage,
  OrderCreatorType,
  OrderStatus,
  Prisma,
  QuotationStatus,
  Role,
  RoomType,
  TileEventType,
  type Product,
} from '@prisma/client';
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
import { percent, percentChange } from '@/common/utils/metrics';
import { QueryTilesDto } from './dto/query-tiles.dto';

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

/**
 * Money actually earned, for every revenue figure below: the customer's payment
 * was verified and the order was not cancelled afterwards. Shipping and delivery
 * are not part of it — the money is in once staff verify the payment — so
 * revenue is dated by `paymentVerifiedAt`, the day it arrived.
 */
const EARNED_WHERE = {
  quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
  status: { not: OrderStatus.CANCELLED },
  paymentVerifiedAt: { not: null },
} satisfies Prisma.OrderWhereInput;

const isEarned = (order: { quotationStatus: QuotationStatus; status: OrderStatus }) =>
  order.quotationStatus === QuotationStatus.PAYMENT_VERIFIED &&
  order.status !== OrderStatus.CANCELLED;

/** The day a verified payment arrived (every earned order has one). */
const earnedAt = (order: { paymentVerifiedAt: Date | null }) => order.paymentVerifiedAt as Date;

/**
 * Two customers who "are the same person" must be counted once. The storefront
 * records browsing under a per-browser session id, the server records orders
 * under the customer's user id — so events are identified by the user when one
 * is known (directly, or because the same session id also appears on an event
 * that names its user), and by the session id only for genuinely anonymous visitors.
 */
const journeyIdentity = (events: { userId: string | null; sessionId: string }[]) => {
  const userBySession = new Map<string, string>();
  for (const event of events) if (event.userId) userBySession.set(event.sessionId, event.userId);
  return (event: { userId: string | null; sessionId: string }) =>
    event.userId ?? userBySession.get(event.sessionId) ?? event.sessionId;
};

const CREATOR_TYPES: OrderCreatorType[] = [OrderCreatorType.CUSTOMER, OrderCreatorType.STAFF];

/**
 * "Sales" is tile revenue, never the delivery cost on top of it — `subtotal`
 * is what the customer's tiles are worth, `total` is `subtotal + transportFee`
 * once the quotation adds one. Every figure below reads `subtotal` for that
 * reason; `transportFee` gets its own, separately-labelled total instead of
 * folding into these.
 */
const orderSubtotal = (order: { subtotal: Prisma.Decimal }) => Number(order.subtotal);

/**
 * Shared by `overview()` and `sales()`: the Customer-vs-Staff split both a
 * KPI card and the "Orders by Creator" chart need — one total per creator
 * type for the card, the same split bucketed over the period for the chart.
 */
const creatorBreakdown = <T extends { createdByType: OrderCreatorType; subtotal: Prisma.Decimal }>(
  orders: T[],
  resolved: ResolvedPeriod,
  dateOf: (order: T) => Date,
) => {
  const byCreator = CREATOR_TYPES.map((createdByType) => {
    const rows = orders.filter((order) => order.createdByType === createdByType);
    return {
      createdByType,
      count: rows.length,
      total: rows.reduce((sum, order) => sum + orderSubtotal(order), 0),
    };
  });

  const trendByType = new Map(
    CREATOR_TYPES.map((createdByType) => [
      createdByType,
      bucketize(
        orders.filter((order) => order.createdByType === createdByType),
        resolved,
        dateOf,
        orderSubtotal,
      ),
    ]),
  );
  const customerTrend = trendByType.get(OrderCreatorType.CUSTOMER)!;
  const staffTrend = trendByType.get(OrderCreatorType.STAFF)!;
  const creatorTrend = customerTrend.map((bucket, index) => ({
    label: bucket.label,
    customer: bucket.value,
    staff: staffTrend[index].value,
  }));

  return { byCreator, creatorTrend };
};

/**
 * Safe field readers for the free-form `metadata` JSON attached to journey
 * events — the frontend controls its shape, so nothing here can assume a
 * key exists or is the right type.
 */
const readMetadataField = (metadata: Prisma.JsonValue, key: string): unknown => {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    return undefined;
  return (metadata as Record<string, unknown>)[key];
};

const readMetadataString = (metadata: Prisma.JsonValue, key: string): string | undefined => {
  const value = readMetadataField(metadata, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const readMetadataNumber = (metadata: Prisma.JsonValue, key: string): number | undefined => {
  const value = readMetadataField(metadata, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const multiplyIfBothNumbers = (a: number | undefined, b: number | undefined): number | undefined =>
  a !== undefined && b !== undefined ? a * b : undefined;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Resolves a batch of products' stored `image` (a bare private-bucket
   * path, or an absolute URL for seeded/external photos — see
   * `StorageService.resolveImageUrl`) to something a client can actually
   * load, keyed by product id. Every analytics endpoint that echoes a
   * product's image alongside engagement/sales numbers goes through this
   * rather than forwarding the raw stored value, which resolves to nothing
   * loadable for any product uploaded through the app.
   */
  private async resolveImageUrls(
    products: { id: string; image: string | null }[],
  ): Promise<Map<string, string | null>> {
    const entries = await Promise.all(
      products.map(
        async (product) =>
          [
            product.id,
            product.image ? await this.storage.resolveImageUrl(product.image) : null,
          ] as const,
      ),
    );
    return new Map(entries);
  }

  // --- Cross-dashboard overview --------------------------------------------

  /** The KPI strip the overview screen leads with. */
  async overview(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [
      earnedOrders,
      totalOrders,
      pendingOrders,
      pendingFulfillments,
      totalCustomers,
      repeatCustomers,
      recommendations,
      products,
      lowStockThreshold,
      funnel,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: EARNED_WHERE,
        select: {
          subtotal: true,
          transportFee: true,
          paymentVerifiedAt: true,
          createdByType: true,
        },
      }),
      this.prisma.order.count(),
      // Placed but not yet paid: waiting on the customer.
      this.prisma.order.count({
        where: {
          status: OrderStatus.PENDING,
          quotationStatus: { not: QuotationStatus.PAYMENT_VERIFIED },
        },
      }),
      // Paid and not yet shipped: waiting on the warehouse.
      this.prisma.order.count({
        where: {
          quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
          status: {
            in: [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.READY_FOR_DISPATCH],
          },
        },
      }),
      this.prisma.user.count({ where: { role: 'CLIENT' } }),
      this.prisma.order.groupBy({
        by: ['customerId'],
        // A repeat customer is one who paid more than once — not one with two unpaid or waitlisted orders.
        where: {
          quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
          status: { not: OrderStatus.CANCELLED },
        },
        _count: { _all: true },
        having: { customerId: { _count: { gt: 1 } } },
      }),
      this.prisma.recommendation.findMany({
        select: { decision: true, purchased: true, matchScore: true },
      }),
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { quantityOnHandSqm: true, averageCostPrice: true },
      }),
      getLowStockThreshold(this.prisma),
      this.conversionFunnel(),
    ]);

    const totalSales = earnedOrders.reduce((sum, order) => sum + orderSubtotal(order), 0);
    const totalTransportFees = earnedOrders.reduce(
      (sum, order) => sum + Number(order.transportFee ?? 0),
      0,
    );
    const accepted = recommendations.filter((row) => row.decision === 'ACCEPTED').length;
    const { byCreator, creatorTrend } = creatorBreakdown(earnedOrders, resolved, earnedAt);

    return {
      period: resolved.period,
      totalSales,
      // Visible separately from `totalSales`, deliberately — see `orderSubtotal`.
      totalTransportFees,
      totalOrders,
      pendingOrders,
      pendingFulfillments,
      averageOrderValue: earnedOrders.length ? totalSales / earnedOrders.length : 0,
      byCreator,
      creatorTrend,
      totalCustomers,
      repeatCustomers: repeatCustomers.length,
      repeatPurchaseRate: percent(repeatCustomers.length, totalCustomers),
      totalRecommendations: recommendations.length,
      recommendationAcceptanceRate: percent(accepted, recommendations.length),
      averageMatchScore: recommendations.length
        ? recommendations.reduce((sum, row) => sum + Number(row.matchScore), 0) /
          recommendations.length
        : 0,
      activeProducts: products.length,
      lowStockItems: products.filter((row) => {
        const onHand = Number(row.quantityOnHandSqm);
        return onHand > 0 && onHand <= lowStockThreshold;
      }).length,
      outOfStockItems: products.filter((row) => Number(row.quantityOnHandSqm) === 0).length,
      // Valued at cost (average purchase price), never at the selling price.
      totalInventoryValue: products.reduce(
        (total, row) => total + Number(row.quantityOnHandSqm) * Number(row.averageCostPrice),
        0,
      ),
      revenueTrend: bucketize(earnedOrders, resolved, earnedAt, orderSubtotal),
      funnel,
    };
  }

  // --- 3.9 Customer profile analytics -------------------------------------

  /** Customer Analytics domain: totals, acquisition channels, project types, new-vs-repeat trend. */
  async customers(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [clients, byHeardAboutUs, repeatCustomers, projectTypes, allOrders] = await Promise.all([
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
      // Every order ever (not just this period) — a customer's *first* order
      // can predate the window, so "was this their first?" needs the full
      // history, even though only orders inside the window get bucketed below.
      this.prisma.order.findMany({
        where: { status: { not: OrderStatus.CANCELLED } },
        select: { customerId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const repeatIds = new Set(repeatCustomers.map((row) => row.customerId));

    // "New vs. repeat" trend: each order counts toward whichever bucket its
    // date falls in, split by whether it was that customer's first order
    // ever (chronologically, via the full-history scan above) or a later one.
    const newOrderBuckets = resolved.buckets.map(() => 0);
    const repeatOrderBuckets = resolved.buckets.map(() => 0);
    const seenCustomers = new Set<string>();
    for (const order of allOrders) {
      const isFirstOrder = !seenCustomers.has(order.customerId);
      seenCustomers.add(order.customerId);

      const time = order.createdAt.getTime();
      if (time < resolved.from.getTime() || time >= resolved.to.getTime()) continue;
      const index = resolved.buckets.findIndex(
        (bucket) => time >= bucket.start.getTime() && time < bucket.end.getTime(),
      );
      if (index < 0) continue;
      if (isFirstOrder) newOrderBuckets[index] += 1;
      else repeatOrderBuckets[index] += 1;
    }

    return {
      period: resolved.period,
      totalCustomers: clients.length,
      activeCustomers: clients.filter((row) => row.status === 'ACTIVE').length,
      newCustomers: clients.filter(
        (row) => row.createdAt >= resolved.from && row.createdAt < resolved.to,
      ).length,
      repeatCustomerCount: repeatIds.size,
      repeatPurchaseRate: percent(repeatIds.size, clients.length),
      /**
       * Acquisition channel breakdown — "how customers discovered the
       * business". Zero-filled across every `HearAboutUs` value (plus
       * "not specified") rather than only the ones with a real count, so
       * the chart always shows the full, consistent set of channels.
       */
      byHeardAboutUs: [...Object.values(HearAboutUs), null].map((source) => ({
        source,
        count: byHeardAboutUs.find((row) => row.heardAboutUs === source)?._count._all ?? 0,
      })),
      projectTypes,
      trend: {
        newCustomers: bucketize(clients, resolved, (row) => row.createdAt),
        // Orders per bucket, split by whether each was the placing
        // customer's first order ever or a later (repeat) one — a real
        // "new vs. repeat" comparison over time, distinct from `newCustomers`
        // above (that one's signups; this one's purchases).
        ordersByCustomerType: {
          new: resolved.buckets.map((bucket, index) => ({
            label: bucket.label,
            value: newOrderBuckets[index],
          })),
          repeat: resolved.buckets.map((bucket, index) => ({
            label: bucket.label,
            value: repeatOrderBuckets[index],
          })),
        },
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
        order: { select: { customerId: true, total: true, status: true, quotationStatus: true } },
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
        if (isEarned(item.order)) {
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

  // --- Tile Analytics domain ------------------------------------------------

  /**
   * The whole Tiles Analytics page in one call: top-10 leaderboards per
   * interaction type, the paginated/searchable per-product table with both
   * documented rates on every row, and the platform-wide summary the table's
   * header cards show — all scoped to the same period, so the leaderboards
   * and the table never disagree about the window they're describing.
   */
  async tiles(query: QueryTilesDto) {
    const resolved = resolvePeriod(query.period);
    const inRange = { gte: resolved.from, lt: resolved.to };
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

    const leaderboardByType = async (type: TileEventType, limit = 10) =>
      this.prisma.tileEvent.groupBy({
        by: ['productId'],
        where: { type, createdAt: inRange },
        _count: { _all: true },
        orderBy: { _count: { productId: 'desc' } },
        take: limit,
      });

    const [
      viewed,
      applied,
      compared,
      saved,
      purchased,
      products,
      total,
      events,
      soldAreaByProduct,
      lowStockThreshold,
    ] = await Promise.all([
      leaderboardByType(TileEventType.VIEWED),
      leaderboardByType(TileEventType.APPLIED),
      leaderboardByType(TileEventType.COMPARED),
      leaderboardByType(TileEventType.SAVED),
      leaderboardByType(TileEventType.PURCHASED),
      this.prisma.product.findMany({
        where,
        include: { collection: { select: { title: true, size: true } } },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
      this.prisma.tileEvent.groupBy({
        by: ['productId', 'type'],
        where: { createdAt: inRange },
        _count: { _all: true },
      }),
      // `purchased` above (a TileEvent count — one per order line, same
      // period) is a "times bought" tally, not a physical quantity. This is
      // the actual area sold in the period, from the earned orders
      // themselves, for the "Sold" column's sqm sub-line.
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { ...EARNED_WHERE, paymentVerifiedAt: inRange } },
        _sum: { requiredAreaSqm: true },
      }),
      getLowStockThreshold(this.prisma),
    ]);
    const soldAreaSqmOf = (productId: string) =>
      Number(
        soldAreaByProduct.find((row) => row.productId === productId)?._sum.requiredAreaSqm ?? 0,
      );

    const leaderboardProductIds = [
      ...new Set(
        [...viewed, ...applied, ...compared, ...saved, ...purchased].map((r) => r.productId),
      ),
    ];
    const leaderboardProducts = await this.prisma.product.findMany({
      where: { id: { in: leaderboardProductIds } },
      select: { id: true, name: true, image: true },
    });
    const leaderboardImageById = await this.resolveImageUrls(leaderboardProducts);
    const productById = (id: string) => leaderboardProducts.find((p) => p.id === id);
    const attach = (rows: { productId: string; _count: { _all: number } }[]) =>
      rows.map((row) => ({
        productId: row.productId,
        name: productById(row.productId)?.name ?? 'Unknown',
        image: leaderboardImageById.get(row.productId) ?? null,
        count: row._count._all,
      }));

    const countOf = (productId: string, type: TileEventType) =>
      events.find((row) => row.productId === productId && row.type === type)?._count._all ?? 0;

    const tableImageById = await this.resolveImageUrls(products);
    const rows = products.map((product) => {
      const productViewed = countOf(product.id, TileEventType.VIEWED);
      const productApplied = countOf(product.id, TileEventType.APPLIED);
      const productPurchased = countOf(product.id, TileEventType.PURCHASED);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        image: tableImageById.get(product.id) ?? product.image,
        collection: product.collection.title,
        size: product.collection.size,
        quantityOnHandSqm: Number(product.quantityOnHandSqm),
        stockStatus: stockStatusOf(Number(product.quantityOnHandSqm), lowStockThreshold),
        viewed: productViewed,
        applied: productApplied,
        compared: countOf(product.id, TileEventType.COMPARED),
        saved: countOf(product.id, TileEventType.SAVED),
        purchased: productPurchased,
        soldAreaSqm: soldAreaSqmOf(product.id),
        selectionRate: percent(productApplied, productViewed),
        purchaseConversion: percent(productPurchased, productViewed),
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
      period: resolved.period,
      leaderboards: {
        mostViewed: attach(viewed),
        mostApplied: attach(applied),
        mostCompared: attach(compared),
        mostSaved: attach(saved),
        mostPurchased: attach(purchased),
      },
      summary: {
        averageSelectionRate: percent(totals.applied, totals.viewed),
        averagePurchaseConversion: percent(totals.purchased, totals.viewed),
        totalViews: totals.viewed,
      },
      table: paginate(rows, total, query.page, query.limit),
    };
  }

  /**
   * Lifetime interaction totals for one tile. The detail surfaces use the
   * complete interaction set (not just the two values needed to calculate
   * the rates), so saves/"likes" and comparisons do not disappear when an
   * analyst moves from the tiles table to the product itself.
   */
  async tileRates(productId: string) {
    const interactions = await this.prisma.tileEvent.groupBy({
      by: ['type'],
      where: { productId },
      _count: { _all: true },
    });
    const countOf = (type: TileEventType) =>
      interactions.find((row) => row.type === type)?._count._all ?? 0;
    const viewed = countOf(TileEventType.VIEWED);
    const applied = countOf(TileEventType.APPLIED);
    const purchased = countOf(TileEventType.PURCHASED);

    return {
      productId,
      viewed,
      applied,
      compared: countOf(TileEventType.COMPARED),
      saved: countOf(TileEventType.SAVED),
      purchased,
      selectionRate: percent(applied, viewed),
      purchaseConversion: percent(purchased, viewed),
    };
  }

  // --- Customer journey / conversion funnel -------------------------------

  /**
   * A funnel counts, at every stage, everyone who got AT LEAST that far —
   * not just sessions that happen to have logged that exact stage's event.
   * Reaching PURCHASED necessarily means OPENED_SYSTEM happened too, even if
   * that earlier event was never recorded (a staff-created order on a
   * customer's behalf never fires the customer's own browsing events, for
   * instance) — so each session's *furthest* stage reached is counted
   * toward every stage up to and including it. This is also what guarantees
   * the funnel can never show a nonsensical negative drop-off (a later stage
   * "gaining" sessions an earlier one doesn't have), which counting exact
   * per-stage events could, and did.
   */
  async conversionFunnel() {
    const events = await this.prisma.customerJourneyEvent.findMany({
      select: { sessionId: true, userId: true, stage: true },
    });

    const identify = journeyIdentity(events);
    const furthestIndexByPerson = new Map<string, number>();
    for (const event of events) {
      const index = JOURNEY_ORDER.indexOf(event.stage);
      if (index === -1) continue;
      const person = identify(event);
      const current = furthestIndexByPerson.get(person) ?? -1;
      if (index > current) furthestIndexByPerson.set(person, index);
    }
    const furthestIndexes = [...furthestIndexByPerson.values()];

    return JOURNEY_ORDER.map((stage, stageIndex) => ({
      stage,
      customers: furthestIndexes.filter((furthest) => furthest >= stageIndex).length,
    }));
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
        select: { createdAt: true, sessionId: true, userId: true, stage: true },
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

    const identify = journeyIdentity(events);
    const sessions = new Set(events.map((row) => identify(row)));
    const purchased = funnel.find((row) => row.stage === JourneyStage.PURCHASED)?.customers ?? 0;

    return {
      period: resolved.period,
      stages,
      totalSessions: sessions.size,
      overallConversionRate: percent(purchased, entry),
      trend: bucketize(events, resolved, (row) => row.createdAt),
    };
  }

  /**
   * Drill-down behind one funnel stage: who actually reached it (their
   * profile, when known — anonymous sessions carry no profile), and what
   * they concretely did there. "What they did" only exists as a real record
   * for stages backed by a domain table (saved a design, requested a quote,
   * negotiated, placed an order, purchased, viewed/applied a tile) — see
   * `journeyStageActions` below. The three earliest stages (opened the
   * system, created a room, entered dimensions) have no backing table, so
   * whatever metadata the frontend attached to the raw event is the action.
   *
   * Unlike `conversionFunnel()`'s cumulative "reached at least this far"
   * count, `userCount` here is sessions that logged *this exact* stage's
   * event — deliberately: the point of a drill-down is showing the concrete
   * action tied to a real event, and inventing membership for a stage that
   * was never actually logged would mean showing an action from a different
   * moment, or none at all. So this number can be smaller than the funnel's
   * for the same stage — that's two different, both-correct questions
   * ("how many got at least this far" vs. "how many events exist here").
   */
  async journeyStageDetail(
    stage: JourneyStage,
    period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY,
    viewerRole?: Role,
  ) {
    const resolved = resolvePeriod(period);

    const events = await this.prisma.customerJourneyEvent.findMany({
      where: { stage, createdAt: { gte: resolved.from, lt: resolved.to } },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, phone: true, role: true, status: true },
        },
      },
    });

    // The funnel itself counts distinct sessions per stage — stage detail
    // must match that, or the user list here won't line up with its count.
    const bySession = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!bySession.has(event.sessionId)) bySession.set(event.sessionId, event);
    }
    const distinctEvents = [...bySession.values()];

    const users = distinctEvents.map((event) => ({
      sessionId: event.sessionId,
      userId: event.userId,
      reachedAt: event.createdAt,
      metadata: event.metadata,
      profile: event.user
        ? {
            id: event.user.id,
            fullName: event.user.fullName,
            email: event.user.email,
            phone: event.user.phone,
            role: event.user.role,
            status: event.user.status,
          }
        : null,
    }));

    const userIds = [
      ...new Set(distinctEvents.map((event) => event.userId).filter((id): id is string => !!id)),
    ];
    const actions = await this.journeyStageActions(
      stage,
      userIds,
      resolved,
      distinctEvents,
      viewerRole,
    );
    const signedInCustomers = new Set(
      distinctEvents.filter((event) => event.userId).map((event) => event.userId),
    ).size;
    const metrics = this.journeyStageMetrics(stage, users.length, signedInCustomers, actions);

    return { stage, period: resolved.period, userCount: users.length, users, actions, metrics };
  }

  /**
   * The KPI strip above a stage's drill-down ledger — deliberately different
   * per stage (doc: "for others, it is the same functionality/features... if
   * it is the other step, it should have different actions and everything"),
   * computed entirely from the `actions` this same call already fetched (no
   * extra queries). `key` is a stable identifier the frontend maps to a
   * translated label and an icon; `value` is the raw number/string — never
   * pre-formatted or pre-translated, same separation every other analytics
   * endpoint here keeps.
   */
  private journeyStageMetrics(
    stage: JourneyStage,
    totalCustomers: number,
    signedInCustomers: number,
    actions: Awaited<ReturnType<AnalyticsService['journeyStageActions']>>,
  ): { key: string; value: number | string }[] {
    const base = [{ key: 'totalCustomers', value: totalCustomers }];

    switch (stage) {
      case JourneyStage.SAVED_DESIGN: {
        const designs = actions as unknown as {
          detail: { sharedWithSales: boolean; tileCount: number };
        }[];
        const shared = designs.filter((row) => row.detail.sharedWithSales).length;
        const avgTiles = designs.length
          ? designs.reduce((sum, row) => sum + row.detail.tileCount, 0) / designs.length
          : 0;
        return [
          ...base,
          { key: 'totalDesigns', value: designs.length },
          { key: 'shareRate', value: percent(shared, designs.length) },
          { key: 'avgTilesPerDesign', value: Math.round(avgTiles * 10) / 10 },
        ];
      }

      case JourneyStage.REQUESTED_QUOTATION: {
        const quotes = actions as unknown as { detail: { status: string; itemCount: number } }[];
        const pending = quotes.filter((row) => row.detail.status === 'REQUESTED').length;
        const avgItems = quotes.length
          ? quotes.reduce((sum, row) => sum + row.detail.itemCount, 0) / quotes.length
          : 0;
        return [
          ...base,
          { key: 'totalQuotes', value: quotes.length },
          { key: 'pendingQuotes', value: pending },
          { key: 'avgItemsPerQuote', value: Math.round(avgItems * 10) / 10 },
        ];
      }

      case JourneyStage.NEGOTIATED: {
        const quoteThreads = actions.filter((row) => row.type === 'QUOTE_NEGOTIATING').length;
        const orderThreads = actions.filter((row) => row.type === 'ORDER_NEGOTIATION').length;
        return [
          ...base,
          { key: 'totalNegotiations', value: actions.length },
          { key: 'quoteThreads', value: quoteThreads },
          { key: 'orderThreads', value: orderThreads },
        ];
      }

      case JourneyStage.PLACED_ORDER:
      case JourneyStage.PURCHASED: {
        const orders = actions as unknown as { detail: { total: number } }[];
        const totalValue = orders.reduce((sum, row) => sum + row.detail.total, 0);
        return [
          ...base,
          {
            key: stage === JourneyStage.PLACED_ORDER ? 'totalOrders' : 'totalPurchases',
            value: orders.length,
          },
          { key: 'totalValue', value: Math.round(totalValue) },
          { key: 'avgValue', value: orders.length ? Math.round(totalValue / orders.length) : 0 },
        ];
      }

      case JourneyStage.VIEWED_TILE:
      case JourneyStage.APPLIED_TILE: {
        const events = actions as unknown as {
          detail: { productId: string; productName: string };
        }[];
        const byProduct = new Map<string, { name: string; count: number }>();
        for (const row of events) {
          const existing = byProduct.get(row.detail.productId);
          if (existing) existing.count += 1;
          else byProduct.set(row.detail.productId, { name: row.detail.productName, count: 1 });
        }
        const top = [...byProduct.values()].sort((a, b) => b.count - a.count)[0];
        return [
          ...base,
          {
            key: stage === JourneyStage.VIEWED_TILE ? 'totalViews' : 'totalApplications',
            value: events.length,
          },
          { key: 'uniqueTiles', value: byProduct.size },
          { key: 'topTile', value: top?.name ?? '—' },
        ];
      }

      case JourneyStage.CREATED_ROOM: {
        const rooms = actions as unknown as {
          detail: { roomType?: RoomType } | Prisma.JsonValue;
        }[];
        const byType = new Map<string, number>();
        for (const row of rooms) {
          const roomType =
            row.detail && typeof row.detail === 'object' && 'roomType' in row.detail
              ? (row.detail as { roomType?: RoomType }).roomType
              : undefined;
          if (!roomType) continue;
          byType.set(roomType, (byType.get(roomType) ?? 0) + 1);
        }
        const top = [...byType.entries()].sort((a, b) => b[1] - a[1])[0];
        return [
          ...base,
          { key: 'totalRoomsStarted', value: rooms.length },
          { key: 'uniqueRoomTypes', value: byType.size },
          { key: 'topRoomType', value: top?.[0] ?? '—' },
        ];
      }

      case JourneyStage.ENTERED_DIMENSIONS: {
        const entries = actions
          .map((row) =>
            row.detail && typeof row.detail === 'object' && 'areaSqm' in (row.detail as object)
              ? Number((row.detail as { areaSqm?: unknown }).areaSqm)
              : undefined,
          )
          .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));
        const avgArea = entries.length
          ? entries.reduce((sum, v) => sum + v, 0) / entries.length
          : 0;
        return [
          ...base,
          { key: 'totalEntries', value: actions.length },
          { key: 'avgAreaSqm', value: Math.round(avgArea * 10) / 10 },
          {
            key: 'maxAreaSqm',
            value: entries.length ? Math.round(Math.max(...entries) * 10) / 10 : 0,
          },
        ];
      }

      default:
        return [...base, { key: 'signedInCustomers', value: signedInCustomers }];
    }
  }

  /**
   * The concrete "action KPI" behind a funnel stage — normalized to one
   * shape (`{ id, userId, type, summary, createdAt, detail }`) regardless of
   * which table it's actually reading from, so the frontend renders every
   * stage's action list the same way.
   */
  private async journeyStageActions(
    stage: JourneyStage,
    userIds: string[],
    resolved: ResolvedPeriod,
    fallbackEvents: {
      userId: string | null;
      sessionId: string;
      createdAt: Date;
      metadata: Prisma.JsonValue;
    }[],
    viewerRole?: Role,
  ) {
    const inRange = { gte: resolved.from, lt: resolved.to };

    switch (stage) {
      case JourneyStage.SAVED_DESIGN: {
        const designs = await this.prisma.roomDesign.findMany({
          where: { userId: { in: userIds }, createdAt: inRange },
          include: {
            room: { select: { type: true, name: true } },
            tiles: { include: { product: { select: { id: true, name: true, image: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        });
        const tileImageById = await this.resolveImageUrls(
          designs.flatMap((design) => design.tiles.map((tile) => tile.product)),
        );
        return designs.map((design) => ({
          id: design.id,
          userId: design.userId,
          type: 'ROOM_DESIGN_SAVED',
          summary: `Saved "${design.name}" (${design.room.type}) — ${design.tiles.length} tile${design.tiles.length === 1 ? '' : 's'}`,
          createdAt: design.createdAt,
          detail: {
            roomType: design.room.type,
            roomName: design.room.name,
            designName: design.name,
            tileCount: design.tiles.length,
            sharedWithSales: design.sharedWithSales,
            tiles: design.tiles.map((tile) => ({
              surface: tile.surface,
              productId: tile.product.id,
              productName: tile.product.name,
              image: tileImageById.get(tile.product.id) ?? tile.product.image,
            })),
          },
        }));
      }

      case JourneyStage.REQUESTED_QUOTATION: {
        const quotes = await this.prisma.quoteRequest.findMany({
          where: { userId: { in: userIds }, createdAt: inRange },
          orderBy: { createdAt: 'desc' },
        });
        return quotes.map((quote) => ({
          id: quote.id,
          userId: quote.userId,
          type: 'QUOTE_REQUESTED',
          summary: `Requested a quote (${Array.isArray(quote.items) ? quote.items.length : 0} item${Array.isArray(quote.items) && quote.items.length === 1 ? '' : 's'})`,
          createdAt: quote.createdAt,
          detail: {
            status: quote.status,
            items: quote.items,
            itemCount: Array.isArray(quote.items) ? quote.items.length : 0,
            orderId: quote.orderId,
          },
        }));
      }

      case JourneyStage.NEGOTIATED: {
        const [negotiatingQuotes, ordersWithMessages] = await Promise.all([
          this.prisma.quoteRequest.findMany({
            where: { userId: { in: userIds }, status: 'NEGOTIATING', updatedAt: inRange },
          }),
          this.prisma.order.findMany({
            where: { customerId: { in: userIds }, messages: { some: { createdAt: inRange } } },
            include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
          }),
        ]);
        return [
          ...negotiatingQuotes.map((quote) => ({
            id: quote.id,
            userId: quote.userId,
            type: 'QUOTE_NEGOTIATING',
            summary: 'Quote moved into negotiation',
            createdAt: quote.updatedAt,
            detail: { status: quote.status, orderId: quote.orderId },
          })),
          ...ordersWithMessages.map((order) => ({
            id: order.id,
            userId: order.customerId,
            type: 'ORDER_NEGOTIATION',
            summary: `Negotiation thread on order ${order.orderNumber}`,
            createdAt: order.messages[0]?.createdAt ?? order.updatedAt,
            detail: {
              orderNumber: order.orderNumber,
              orderId: order.id,
              // What was said on a negotiation thread is off-limits to the data
              // analyst (403 on the thread endpoints) — that must hold here too.
              lastMessage:
                viewerRole === Role.DATA_ANALYST ? null : (order.messages[0]?.body ?? null),
            },
          })),
        ];
      }

      case JourneyStage.PLACED_ORDER: {
        const orders = await this.prisma.order.findMany({
          where: { customerId: { in: userIds }, createdAt: inRange },
          orderBy: { createdAt: 'desc' },
        });
        return orders.map((order) => ({
          id: order.id,
          userId: order.customerId,
          type: 'ORDER_PLACED',
          summary: `Placed order ${order.orderNumber} — ${order.currency} ${Number(order.total).toLocaleString()}`,
          createdAt: order.createdAt,
          detail: {
            orderNumber: order.orderNumber,
            status: order.status,
            total: Number(order.total),
          },
        }));
      }

      case JourneyStage.PURCHASED: {
        const orders = await this.prisma.order.findMany({
          where: {
            customerId: { in: userIds },
            status: OrderStatus.DELIVERED,
            deliveredAt: inRange,
          },
          orderBy: { deliveredAt: 'desc' },
        });
        return orders.map((order) => ({
          id: order.id,
          userId: order.customerId,
          type: 'ORDER_PURCHASED',
          summary: `Purchased — order ${order.orderNumber}`,
          createdAt: order.deliveredAt ?? order.updatedAt,
          detail: { orderNumber: order.orderNumber, total: Number(order.total) },
        }));
      }

      case JourneyStage.VIEWED_TILE:
      case JourneyStage.APPLIED_TILE: {
        const type =
          stage === JourneyStage.VIEWED_TILE ? TileEventType.VIEWED : TileEventType.APPLIED;
        // Unlike the stages below (which all require a signed-in account —
        // you can't place an order or save a design anonymously), browsing
        // tiles doesn't. Matching by `userId` alone silently drops every
        // anonymous session's views/applies, which is most of them — match
        // by `sessionId` instead, the same identifier `fallbackEvents` (and
        // CREATED_ROOM/ENTERED_DIMENSIONS below) already key off of, so an
        // anonymous session's own tile events are still found.
        const sessionIds = fallbackEvents.map((event) => event.sessionId);
        const tileEvents = await this.prisma.tileEvent.findMany({
          where: { sessionId: { in: sessionIds }, type, createdAt: inRange },
          include: { product: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: 'desc' },
        });
        const tileImageById = await this.resolveImageUrls(tileEvents.map((event) => event.product));
        return tileEvents.map((event) => ({
          id: event.id,
          userId: event.userId,
          type: `TILE_${type}`,
          summary: `${type === TileEventType.VIEWED ? 'Viewed' : 'Applied'} "${event.product.name}"`,
          createdAt: event.createdAt,
          detail: {
            productId: event.productId,
            productName: event.product.name,
            image: tileImageById.get(event.productId) ?? event.product.image,
          },
        }));
      }

      case JourneyStage.CREATED_ROOM: {
        // No dedicated "room started" table — the frontend attaches which
        // room template was picked as event metadata (`roomId`). Resolve it
        // to the real Room when present so the action is real domain data,
        // not a raw JSON blob; degrade gracefully when it isn't sent.
        const roomIds = [
          ...new Set(
            fallbackEvents
              .map((event) => readMetadataString(event.metadata, 'roomId'))
              .filter((id): id is string => !!id),
          ),
        ];
        const rooms = roomIds.length
          ? await this.prisma.room.findMany({ where: { id: { in: roomIds } } })
          : [];

        return fallbackEvents.map((event) => {
          const roomId = readMetadataString(event.metadata, 'roomId');
          const room = roomId ? rooms.find((r) => r.id === roomId) : undefined;
          return {
            id: `${event.sessionId}:${event.createdAt.getTime()}`,
            userId: event.userId,
            type: 'ROOM_CREATED',
            summary: room
              ? `Started a ${room.type.replace(/_/g, ' ').toLowerCase()} design ("${room.name}")`
              : 'Started a new room design',
            createdAt: event.createdAt,
            detail: room
              ? {
                  roomId: room.id,
                  roomType: room.type,
                  roomName: room.name,
                  thumbnail: room.thumbnail,
                }
              : (event.metadata ?? null),
          };
        });
      }

      case JourneyStage.ENTERED_DIMENSIONS: {
        // Same story — no backing table, so this formats whatever dimension
        // fields the frontend sent (`areaSqm`, or `length`×`width`) into a
        // real summary instead of leaving it as opaque JSON.
        return fallbackEvents.map((event) => {
          const areaSqm =
            readMetadataNumber(event.metadata, 'areaSqm') ??
            readMetadataNumber(event.metadata, 'totalAreaSqm') ??
            multiplyIfBothNumbers(
              readMetadataNumber(event.metadata, 'length'),
              readMetadataNumber(event.metadata, 'width'),
            );
          return {
            id: `${event.sessionId}:${event.createdAt.getTime()}`,
            userId: event.userId,
            type: 'DIMENSIONS_ENTERED',
            summary:
              areaSqm !== undefined
                ? `Entered dimensions — ${areaSqm.toLocaleString()} m²`
                : 'Entered room dimensions',
            createdAt: event.createdAt,
            detail: event.metadata ?? null,
          };
        });
      }

      // OPENED_SYSTEM is the one stage with genuinely no "action" behind it
      // — arriving at the system isn't a thing a customer does, it's the
      // starting line every session begins from.
      default:
        return [];
    }
  }

  // --- Sales Analytics domain ------------------------------------------------

  /** Lifetime customer-loyalty figure, shared by `sales()` and `overview()`. */
  private async repeatPurchaseRateValue() {
    const [repeatCustomers, totalCustomers] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: {
          quotationStatus: QuotationStatus.PAYMENT_VERIFIED,
          status: { not: OrderStatus.CANCELLED },
        },
        _count: { _all: true },
        having: { customerId: { _count: { gt: 1 } } },
      }),
      this.prisma.user.count({ where: { role: 'CLIENT' } }),
    ]);
    return {
      repeatCustomers: repeatCustomers.length,
      totalCustomers,
      repeatPurchaseRate: percent(repeatCustomers.length, totalCustomers),
    };
  }

  /**
   * The whole Sales Analytics page in one call — headline total, "vs last
   * period" comparison, order/revenue breakdowns, best sellers, and the
   * (lifetime) repeat-purchase rate. Every money-shaped breakdown here is
   * scoped to the selected period, consistently — unlike the older split
   * endpoints this replaces, where the headline total was period-scoped but
   * `byStatus`/`bestSellingTiles` quietly weren't.
   */
  async sales(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);
    const spanMs = resolved.to.getTime() - resolved.from.getTime();
    const previousFrom = new Date(resolved.from.getTime() - spanMs);
    const inRange = { gte: resolved.from, lt: resolved.to };

    const [earnedOrders, previousTotal, placedOrders, byStatusRaw, bestSelling, repeatPurchase] =
      await Promise.all([
        this.prisma.order.findMany({
          where: { ...EARNED_WHERE, paymentVerifiedAt: inRange },
          select: {
            subtotal: true,
            transportFee: true,
            paymentVerifiedAt: true,
            createdByType: true,
          },
        }),
        this.prisma.order.aggregate({
          where: { ...EARNED_WHERE, paymentVerifiedAt: { gte: previousFrom, lt: resolved.from } },
          _sum: { subtotal: true },
        }),
        // Orders placed in the period, whatever became of them.
        this.prisma.order.count({ where: { createdAt: inRange } }),
        this.prisma.order.groupBy({
          by: ['status'],
          where: { createdAt: inRange },
          _count: { _all: true },
          _sum: { subtotal: true },
        }),
        this.prisma.orderItem.groupBy({
          by: ['productId'],
          // Same "earned" scope as `earnedOrders` above — an item on an unpaid
          // or cancelled order hasn't actually sold anything.
          where: { order: { ...EARNED_WHERE, paymentVerifiedAt: inRange } },
          _sum: { totalPrice: true, totalPieces: true },
          orderBy: { _sum: { totalPrice: 'desc' } },
          take: 10,
        }),
        this.repeatPurchaseRateValue(),
      ]);

    const productIds = bestSelling.map((row) => row.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const bestSellingImageById = await this.resolveImageUrls(products);
    const totalSales = earnedOrders.reduce((sum, order) => sum + orderSubtotal(order), 0);
    const totalTransportFees = earnedOrders.reduce(
      (sum, order) => sum + Number(order.transportFee ?? 0),
      0,
    );
    const previousTotalSales = Number(previousTotal._sum.subtotal ?? 0);

    const bestSellingTiles = bestSelling.map((row) => {
      const product = products.find((p: Product) => p.id === row.productId);
      return {
        productId: row.productId,
        name: product?.name ?? 'Unknown',
        image: bestSellingImageById.get(row.productId) ?? null,
        revenue: Number(row._sum.totalPrice ?? 0),
        pieces: row._sum.totalPieces ?? 0,
      };
    });

    const byStatus = byStatusRaw.map((row) => ({
      status: row.status,
      count: row._count._all,
      total: Number(row._sum.subtotal ?? 0),
    }));
    const { byCreator, creatorTrend } = creatorBreakdown(earnedOrders, resolved, earnedAt);
    const trend = bucketize(earnedOrders, resolved, earnedAt, orderSubtotal);

    return {
      period: resolved.period,
      totalSales,
      // Visible separately from `totalSales`, deliberately — see `orderSubtotal`.
      totalTransportFees,
      previousTotalSales,
      percentChangeVsLastPeriod: percentChange(totalSales, previousTotalSales),
      // Orders placed in the period — the same meaning as the Overview's total —
      // and, separately, how many of them earned money (the average is over those).
      totalOrders: placedOrders,
      paidOrders: earnedOrders.length,
      averageOrderValue: earnedOrders.length ? totalSales / earnedOrders.length : 0,
      ...repeatPurchase,
      byStatus,
      byCreator,
      creatorTrend,
      bestSellingTiles,
      topPerformer: bestSellingTiles[0] ?? null,
      trend,
    };
  }

  // --- AI recommendation performance (nested under Tile Analytics — recs are about tiles) ---

  /**
   * The whole AI Analytics page in one call: the acceptance/purchase-rate
   * summary plus the paginated/searchable per-product breakdown, both scoped
   * to the same period.
   */
  async tileRecommendations(query: QueryTilesDto) {
    const resolved = resolvePeriod(query.period);
    const inRange = { gte: resolved.from, lt: resolved.to };
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

    const [summaryRows, products, total, grouped, lowStockThreshold] = await Promise.all([
      this.prisma.recommendation.findMany({
        where: { createdAt: inRange },
        select: { decision: true, purchased: true, matchScore: true, createdAt: true },
      }),
      this.prisma.product.findMany({
        where,
        include: { collection: { select: { title: true, size: true } } },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
      this.prisma.recommendation.groupBy({
        by: ['productId', 'decision'],
        where: { createdAt: inRange },
        _count: { _all: true },
        _avg: { matchScore: true },
      }),
      getLowStockThreshold(this.prisma),
    ]);

    const accepted = summaryRows.filter((row) => row.decision === 'ACCEPTED').length;
    const rejected = summaryRows.filter((row) => row.decision === 'REJECTED').length;
    const purchased = summaryRows.filter((row) => row.purchased).length;

    // Two real per-bucket series for the "AI Recommendations" chart — average
    // match score and acceptance rate, both over time — computed in one pass
    // over `summaryRows` since `bucketize` only sums a single value.
    const bucketTotals = resolved.buckets.map(() => ({ matchScoreSum: 0, count: 0, accepted: 0 }));
    for (const row of summaryRows) {
      const time = row.createdAt.getTime();
      const index = resolved.buckets.findIndex(
        (bucket) => time >= bucket.start.getTime() && time < bucket.end.getTime(),
      );
      if (index < 0) continue;
      bucketTotals[index].count += 1;
      bucketTotals[index].matchScoreSum += Number(row.matchScore);
      if (row.decision === 'ACCEPTED') bucketTotals[index].accepted += 1;
    }
    const matchScoreTrend = resolved.buckets.map((bucket, index) => ({
      label: bucket.label,
      value: bucketTotals[index].count
        ? bucketTotals[index].matchScoreSum / bucketTotals[index].count
        : 0,
    }));
    const acceptanceTrend = resolved.buckets.map((bucket, index) => ({
      label: bucket.label,
      value: percent(bucketTotals[index].accepted, bucketTotals[index].count),
    }));

    const recommendationImageById = await this.resolveImageUrls(products);
    const rows = products.map((product) => {
      const forProduct = grouped.filter((row) => row.productId === product.id);
      const displayed = forProduct.reduce((sum, row) => sum + row._count._all, 0);
      const productAccepted =
        forProduct.find((row) => row.decision === 'ACCEPTED')?._count._all ?? 0;
      const scores = forProduct.filter((row) => row._avg.matchScore !== null);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        image: recommendationImageById.get(product.id) ?? product.image,
        collection: product.collection.title,
        size: product.collection.size,
        quantityOnHandSqm: Number(product.quantityOnHandSqm),
        stockStatus: stockStatusOf(Number(product.quantityOnHandSqm), lowStockThreshold),
        displayed,
        accepted: productAccepted,
        acceptanceRate: percent(productAccepted, displayed),
        averageMatchScore: scores.length
          ? scores.reduce((sum, row) => sum + Number(row._avg.matchScore), 0) / scores.length
          : 0,
      };
    });

    return {
      period: resolved.period,
      summary: {
        displayed: summaryRows.length,
        accepted,
        rejected,
        purchased,
        acceptanceRate: percent(accepted, summaryRows.length),
        purchaseRate: percent(purchased, summaryRows.length),
        averageMatchScore: summaryRows.length
          ? summaryRows.reduce((sum, row) => sum + Number(row.matchScore), 0) / summaryRows.length
          : 0,
        trend: bucketize(summaryRows, resolved, (row) => row.createdAt),
        matchScoreTrend,
        acceptanceTrend,
      },
      table: paginate(rows, total, query.page, query.limit),
    };
  }
}

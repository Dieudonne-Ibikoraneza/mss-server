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

/** Orders that represent money actually earned, for every revenue figure below. */
const EARNED_STATUSES: OrderStatus[] = [OrderStatus.SHIPPED, OrderStatus.DELIVERED];

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
  constructor(private readonly prisma: PrismaService) {}

  // --- Cross-dashboard overview --------------------------------------------

  /** The KPI strip the overview screen leads with. */
  async overview(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
    const resolved = resolvePeriod(period);

    const [
      earnedOrders,
      totalOrders,
      pendingOrders,
      totalCustomers,
      repeatCustomers,
      recommendations,
      products,
      lowStockThreshold,
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
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { quantityOnHandSqm: true, averageCostPrice: true },
      }),
      getLowStockThreshold(this.prisma),
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

  /** Customer Analytics domain: totals, acquisition channels, project types, new-vs-repeat trend. */
  async customers(period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
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
      /** Acquisition channel breakdown — "how customers discovered the business". */
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
      getLowStockThreshold(this.prisma),
    ]);

    const leaderboardProductIds = [
      ...new Set(
        [...viewed, ...applied, ...compared, ...saved, ...purchased].map((r) => r.productId),
      ),
    ];
    const leaderboardProducts = await this.prisma.product.findMany({
      where: { id: { in: leaderboardProductIds } },
      select: { id: true, name: true, image: true },
    });
    const productById = (id: string) => leaderboardProducts.find((p) => p.id === id);
    const attach = (rows: { productId: string; _count: { _all: number } }[]) =>
      rows.map((row) => ({
        productId: row.productId,
        name: productById(row.productId)?.name ?? 'Unknown',
        image: productById(row.productId)?.image ?? null,
        count: row._count._all,
      }));

    const countOf = (productId: string, type: TileEventType) =>
      events.find((row) => row.productId === productId && row.type === type)?._count._all ?? 0;

    const rows = products.map((product) => {
      const productViewed = countOf(product.id, TileEventType.VIEWED);
      const productApplied = countOf(product.id, TileEventType.APPLIED);
      const productPurchased = countOf(product.id, TileEventType.PURCHASED);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        image: product.image,
        collection: product.collection.title,
        size: product.collection.size,
        quantityOnHandSqm: Number(product.quantityOnHandSqm),
        stockStatus: stockStatusOf(Number(product.quantityOnHandSqm), lowStockThreshold),
        viewed: productViewed,
        applied: productApplied,
        compared: countOf(product.id, TileEventType.COMPARED),
        saved: countOf(product.id, TileEventType.SAVED),
        purchased: productPurchased,
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
      select: { sessionId: true, stage: true },
    });

    const furthestIndexBySession = new Map<string, number>();
    for (const event of events) {
      const index = JOURNEY_ORDER.indexOf(event.stage);
      if (index === -1) continue;
      const current = furthestIndexBySession.get(event.sessionId) ?? -1;
      if (index > current) furthestIndexBySession.set(event.sessionId, index);
    }
    const furthestIndexes = [...furthestIndexBySession.values()];

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
  async journeyStageDetail(stage: JourneyStage, period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY) {
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
    const actions = await this.journeyStageActions(stage, userIds, resolved, distinctEvents);

    return { stage, period: resolved.period, userCount: users.length, users, actions };
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
  ) {
    const inRange = { gte: resolved.from, lt: resolved.to };

    switch (stage) {
      case JourneyStage.SAVED_DESIGN: {
        const designs = await this.prisma.roomDesign.findMany({
          where: { userId: { in: userIds }, createdAt: inRange },
          include: { room: { select: { type: true, name: true } }, tiles: true },
          orderBy: { createdAt: 'desc' },
        });
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
          detail: { status: quote.status, items: quote.items },
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
            detail: { status: quote.status },
          })),
          ...ordersWithMessages.map((order) => ({
            id: order.id,
            userId: order.customerId,
            type: 'ORDER_NEGOTIATION',
            summary: `Negotiation thread on order ${order.orderNumber}`,
            createdAt: order.messages[0]?.createdAt ?? order.updatedAt,
            detail: {
              orderNumber: order.orderNumber,
              lastMessage: order.messages[0]?.body ?? null,
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
        const tileEvents = await this.prisma.tileEvent.findMany({
          where: { userId: { in: userIds }, type, createdAt: inRange },
          include: { product: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: 'desc' },
        });
        return tileEvents.map((event) => ({
          id: event.id,
          userId: event.userId,
          type: `TILE_${type}`,
          summary: `${type === TileEventType.VIEWED ? 'Viewed' : 'Applied'} "${event.product.name}"`,
          createdAt: event.createdAt,
          detail: {
            productId: event.productId,
            productName: event.product.name,
            image: event.product.image,
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
        where: { status: { not: OrderStatus.CANCELLED } },
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

    const [earnedOrders, previousTotal, byStatusRaw, bestSelling, repeatPurchase] =
      await Promise.all([
        this.prisma.order.findMany({
          where: { status: { in: EARNED_STATUSES }, createdAt: inRange },
          select: { total: true, createdAt: true, createdByType: true },
        }),
        this.prisma.order.aggregate({
          where: {
            status: { in: EARNED_STATUSES },
            createdAt: { gte: previousFrom, lt: resolved.from },
          },
          _sum: { total: true },
        }),
        this.prisma.order.groupBy({
          by: ['status'],
          where: { createdAt: inRange },
          _count: { _all: true },
          _sum: { total: true },
        }),
        this.prisma.orderItem.groupBy({
          by: ['productId'],
          where: { order: { createdAt: inRange } },
          _sum: { totalPrice: true, totalPieces: true },
          orderBy: { _sum: { totalPrice: 'desc' } },
          take: 10,
        }),
        this.repeatPurchaseRateValue(),
      ]);

    const productIds = bestSelling.map((row) => row.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const totalSales = earnedOrders.reduce((sum, order) => sum + Number(order.total), 0);
    const previousTotalSales = Number(previousTotal._sum.total ?? 0);

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

    const byStatus = byStatusRaw.map((row) => ({
      status: row.status,
      count: row._count._all,
      total: Number(row._sum.total ?? 0),
    }));
    const byCreator = (['CUSTOMER', 'STAFF'] as const).map((createdByType) => ({
      createdByType,
      count: earnedOrders.filter((order) => order.createdByType === createdByType).length,
      total: earnedOrders
        .filter((order) => order.createdByType === createdByType)
        .reduce((sum, order) => sum + Number(order.total), 0),
    }));
    const trend = bucketize(
      earnedOrders,
      resolved,
      (order) => order.createdAt,
      (order) => Number(order.total),
    );

    return {
      period: resolved.period,
      totalSales,
      previousTotalSales,
      percentChangeVsLastPeriod: percentChange(totalSales, previousTotalSales),
      totalOrders: earnedOrders.length,
      averageOrderValue: earnedOrders.length ? totalSales / earnedOrders.length : 0,
      ...repeatPurchase,
      byStatus,
      byCreator,
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
    const purchased = summaryRows.filter((row) => row.purchased).length;

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
        image: product.image,
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
        purchased,
        acceptanceRate: percent(accepted, summaryRows.length),
        purchaseRate: percent(purchased, summaryRows.length),
        averageMatchScore: summaryRows.length
          ? summaryRows.reduce((sum, row) => sum + Number(row.matchScore), 0) / summaryRows.length
          : 0,
        trend: bucketize(summaryRows, resolved, (row) => row.createdAt),
      },
      table: paginate(rows, total, query.page, query.limit),
    };
  }
}

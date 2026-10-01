import { Prisma, RoomType, SuitableFor, TileEventType } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { QueryTilesDto, TileAnalyticsSort } from './dto/query-tiles.dto';
import { AnalyticsPeriod, resolvePeriod } from '@/common/utils/analytics-period';

describe('tile analytics catalogue rankings', () => {
  const products = ['Zulu', 'Alpha', 'Bravo', 'Charlie'].map((name, index) => ({
    id: `tile-${index}`,
    name,
    sku: `SKU-${index}`,
    image: `https://example.com/${index}.png`,
    collection: { title: 'Stone', size: index % 2 === 0 ? '40x40' : '60x60' },
    roomTypes: [[RoomType.KITCHEN], [RoomType.BEDROOM], [RoomType.KITCHEN], [RoomType.BATHROOM]][
      index
    ],
    suitableFor: [SuitableFor.FLOOR, SuitableFor.WALL, SuitableFor.BOTH, SuitableFor.FLOOR][index],
    quantityOnHandSqm: [100, 10, 0, 80][index],
  }));
  // Stored order differs from every descending metric ranking, and one tile
  // has no activity. Winners must be chosen before taking a one-item page.
  const counts = {
    [TileEventType.VIEWED]: [10, 20, 40, 0],
    [TileEventType.APPLIED]: [5, 8, 10, 0],
    [TileEventType.SAVED]: [2, 7, 3, 0],
    [TileEventType.PURCHASED]: [1, 2, 4, 0],
  };
  const events = Object.entries(counts).flatMap(([type, values]) =>
    values.flatMap((count, index) =>
      count
        ? [
            {
              productId: products[index].id,
              type,
              _count: { _all: count },
            },
          ]
        : [],
    ),
  );
  const prisma = {
    product: {
      findMany: jest
        .fn<Promise<typeof products>, [Prisma.ProductFindManyArgs]>()
        .mockResolvedValue(products),
      count: jest.fn().mockResolvedValue(products.length),
    },
    tileEvent: {
      groupBy: jest.fn(({ by }: { by: string[] }) =>
        Promise.resolve(by.includes('type') ? events : []),
      ),
    },
    recommendation: {
      groupBy: jest.fn().mockResolvedValue([
        { productId: products[0].id, _count: { _all: 12 } },
        { productId: products[1].id, _count: { _all: 2 } },
        { productId: products[2].id, _count: { _all: 30 } },
      ]),
    },
    orderItem: { groupBy: jest.fn().mockResolvedValue([]) },
    platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const service = new AnalyticsService(
    prisma as never,
    {
      resolveImageUrl: jest.fn((image: string) => Promise.resolve(image)),
    } as never,
  );
  const query = (sort: TileAnalyticsSort, page = 1) =>
    Object.assign(new QueryTilesDto(), {
      period: AnalyticsPeriod.MONTHLY,
      sort,
      page,
      limit: 1,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it.each([
    [TileAnalyticsSort.VIEWED_DESC, ['Bravo', 'Alpha', 'Zulu', 'Charlie']],
    [TileAnalyticsSort.VIEWED_ASC, ['Charlie', 'Zulu', 'Alpha', 'Bravo']],
    [TileAnalyticsSort.APPLIED_DESC, ['Bravo', 'Alpha', 'Zulu', 'Charlie']],
    [TileAnalyticsSort.APPLIED_ASC, ['Charlie', 'Zulu', 'Alpha', 'Bravo']],
    [TileAnalyticsSort.RECOMMENDED_DESC, ['Bravo', 'Zulu', 'Alpha', 'Charlie']],
    [TileAnalyticsSort.RECOMMENDED_ASC, ['Charlie', 'Alpha', 'Zulu', 'Bravo']],
    [TileAnalyticsSort.SAVED_DESC, ['Alpha', 'Bravo', 'Zulu', 'Charlie']],
    [TileAnalyticsSort.SAVED_ASC, ['Charlie', 'Zulu', 'Bravo', 'Alpha']],
    [TileAnalyticsSort.PURCHASED_DESC, ['Bravo', 'Alpha', 'Zulu', 'Charlie']],
    [TileAnalyticsSort.PURCHASED_ASC, ['Charlie', 'Zulu', 'Alpha', 'Bravo']],
    [TileAnalyticsSort.SELECTION_RATE_DESC, ['Zulu', 'Alpha', 'Bravo', 'Charlie']],
    [TileAnalyticsSort.SELECTION_RATE_ASC, ['Charlie', 'Bravo', 'Alpha', 'Zulu']],
    [TileAnalyticsSort.NAME_ASC, ['Alpha', 'Bravo', 'Charlie', 'Zulu']],
    [TileAnalyticsSort.NAME_DESC, ['Zulu', 'Charlie', 'Bravo', 'Alpha']],
  ])('%s ranks the full catalogue before pagination', async (sort, expected) => {
    const names: string[] = [];
    for (let page = 1; page <= products.length; page++) {
      const result = await service.tiles(query(sort, page));
      expect(result.table.items).toHaveLength(1);
      names.push(result.table.items[0].name);
      expect(result.table.meta).toMatchObject({ page, total: 4, totalPages: 4 });
    }
    expect(names).toEqual(expected);
    expect(prisma.product.findMany.mock.calls[0][0]).not.toHaveProperty('take');
  });

  it('returns actual recommendation counts and selection rates for the selected period', async () => {
    const result = await service.tiles(query(TileAnalyticsSort.SELECTION_RATE_DESC));
    expect(result.table.items[0]).toMatchObject({
      name: 'Zulu',
      viewed: 10,
      applied: 5,
      recommended: 12,
      selectionRate: 50,
    });
    const resolved = resolvePeriod(AnalyticsPeriod.MONTHLY);
    expect(prisma.recommendation.groupBy).toHaveBeenCalledWith({
      by: ['productId'],
      where: { createdAt: { gte: resolved.from, lt: resolved.to } },
      _count: { _all: true },
    });
    const empty = await service.tiles(query(TileAnalyticsSort.SELECTION_RATE_ASC));
    expect(empty.table.items[0]).toMatchObject({ recommended: 0, selectionRate: 0 });
  });

  it.each([
    [{ roomTypes: 'KITCHEN' }, ['Bravo', 'Zulu']],
    [{ roomTypes: 'KITCHEN,BEDROOM' }, ['Bravo', 'Alpha', 'Zulu']],
    [{ suitableFor: 'FLOOR,BOTH' }, ['Bravo', 'Zulu', 'Charlie']],
    [{ suitableFor: 'WALL,BOTH' }, ['Bravo', 'Alpha']],
    [{ sizes: '60x60' }, ['Alpha', 'Charlie']],
    [{ stockStatuses: 'in_stock' }, ['Zulu', 'Charlie']],
    [{ stockStatuses: 'low_stock' }, ['Alpha']],
    [{ stockStatuses: 'out_of_stock' }, ['Bravo']],
    [{ stockStatuses: 'low_stock,out_of_stock' }, ['Bravo', 'Alpha']],
    [{ search: 'sKu-1' }, ['Alpha']],
    [
      { roomTypes: 'BEDROOM', suitableFor: 'WALL', sizes: '60x60', stockStatuses: 'low_stock' },
      ['Alpha'],
    ],
    [{ roomTypes: 'BEDROOM', sizes: '40x40' }, []],
  ])('filters %j before ranking and pagination', async (filters, expected) => {
    const names: string[] = [];
    for (let page = 1; page <= Math.max(expected.length, 1); page++) {
      const result = await service.tiles(
        Object.assign(query(TileAnalyticsSort.VIEWED_DESC, page), filters),
      );
      names.push(...result.table.items.map((row) => row.name));
      expect(result.table.meta).toMatchObject({
        total: expected.length,
        totalPages: Math.max(expected.length, 1),
      });
      // Size options cover the catalogue even when no products match.
      expect(result.filters.sizes).toEqual(['40x40', '60x60']);
    }
    expect(names).toEqual(expected);
  });

  it('keeps global previews independent of the current page and catalogue filters', async () => {
    const result = await service.tiles(
      Object.assign(query(TileAnalyticsSort.NAME_ASC, 2), { search: 'Charlie' }),
    );
    expect(result.table.items).toEqual([]);
    expect(result.previews.mostViewed.map((row) => row.name)).toEqual(['Bravo', 'Alpha', 'Zulu']);
    expect(result.previews.mostLiked.map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Zulu']);
  });

  it('includes an older top performer beyond the newest 100 products', async () => {
    const catalogue = Array.from({ length: 101 }, (_, index) => ({
      ...products[0],
      id: `catalogue-${index}`,
      name: `Product ${index}`,
    }));
    prisma.product.findMany.mockResolvedValueOnce(catalogue);
    for (let index = 0; index < 5; index++) prisma.tileEvent.groupBy.mockResolvedValueOnce([]);
    prisma.tileEvent.groupBy.mockResolvedValueOnce([
      { productId: catalogue[100].id, type: TileEventType.VIEWED, _count: { _all: 1000 } },
      { productId: catalogue[100].id, type: TileEventType.SAVED, _count: { _all: 500 } },
    ]);
    const result = await service.tiles(Object.assign(new QueryTilesDto(), { limit: 1 }));
    expect(result.table.items[0].productId).toBe(catalogue[0].id);
    expect(result.table.meta.total).toBe(101);
    expect(result.previews.mostViewed[0].productId).toBe(catalogue[100].id);
    expect(result.previews.mostLiked[0].productId).toBe(catalogue[100].id);
  });
});

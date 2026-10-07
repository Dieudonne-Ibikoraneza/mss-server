import { JourneyStage, OrderStatus, QuotationStatus, QuoteStatus, Role } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

const profile = {
  id: 'customer',
  fullName: 'Customer',
  email: 'customer@example.test',
  phone: null,
  role: Role.CLIENT,
  status: 'ACTIVE',
};
const order = (
  id = 'order',
  quotationStatus: QuotationStatus = QuotationStatus.AWAITING_REVIEW,
) => ({
  id,
  customerId: profile.id,
  customer: profile,
  orderNumber: `ORD-${id}`,
  createdAt: new Date('2026-10-05T12:00:00Z'),
  status: OrderStatus.PENDING,
  quotationStatus,
  _count: { items: 2 },
});
const quote = (id = 'quote') => ({
  id,
  userId: profile.id,
  user: profile,
  createdAt: new Date('2026-10-04T12:00:00Z'),
  orderId: null as string | null,
  order: null as { status: OrderStatus; quotationStatus: QuotationStatus } | null,
  status: QuoteStatus.REQUESTED,
  items: [{ productId: 'tile' }],
});
type Row = ReturnType<typeof order> | ReturnType<typeof quote>;
type Query = { where: { createdAt: { gte: Date; lt: Date } } };
const inPeriod = (rows: Row[], query: Query) =>
  rows.filter(
    (row) => row.createdAt >= query.where.createdAt.gte && row.createdAt < query.where.createdAt.lt,
  );

describe('quotation requested journey', () => {
  const orders = jest.fn();
  const quotes = jest.fn();
  const events = jest.fn();
  let service: AnalyticsService;
  const detail = () =>
    service.journeyStageDetail(JourneyStage.REQUESTED_QUOTATION, AnalyticsPeriod.MONTHLY);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T12:00:00Z'));
    jest.clearAllMocks();
    orders.mockResolvedValue([order()]);
    quotes.mockResolvedValue([]);
    events.mockResolvedValue([]);
    service = new AnalyticsService(
      {
        order: { findMany: orders },
        quoteRequest: { findMany: quotes },
        customerJourneyEvent: { findMany: events },
      } as never,
      {} as never,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('shows historical order submissions even without a quotation journey event', async () => {
    const result = await detail();
    expect(result.userCount).toBe(1);
    expect(result.users[0].profile).toMatchObject(profile);
    expect(result.actions[0]).toMatchObject({
      type: 'QUOTE_REQUESTED',
      userId: profile.id,
      detail: { orderId: 'order', orderNumber: 'ORD-order', status: 'PENDING', itemCount: 2 },
    });
    expect(result.metrics.find((row) => row.key === 'totalQuotes')?.value).toBe(1);
  });

  it.each([
    QuotationStatus.AWAITING_REVIEW,
    QuotationStatus.QUOTATION_SENT,
    QuotationStatus.PAYMENT_SUBMITTED,
  ])('keeps %s pending until staff verify payment', async (state) => {
    orders.mockResolvedValue([order('order', state)]);
    const result = await detail();
    expect(result.actions[0].detail).toMatchObject({ status: 'PENDING' });
    expect(result.metrics.find((row) => row.key === 'pendingQuotes')?.value).toBe(1);
    expect(result.metrics.find((row) => row.key === 'resolvedQuotes')?.value).toBe(0);
  });

  it('changes the same request from pending to resolved when payment is verified', async () => {
    const before = await detail();
    orders.mockResolvedValue([order('order', QuotationStatus.PAYMENT_VERIFIED)]);
    const after = await detail();
    expect(before.actions[0].id).toBe(after.actions[0].id);
    expect(after.actions[0].detail).toMatchObject({ status: 'RESOLVED' });
    expect(after.metrics.find((row) => row.key === 'pendingQuotes')?.value).toBe(0);
    expect(after.metrics.find((row) => row.key === 'resolvedQuotes')?.value).toBe(1);
  });

  it('does not count cancelled requests as pending or resolved', async () => {
    orders.mockResolvedValue([
      { ...order('order', QuotationStatus.PAYMENT_VERIFIED), status: OrderStatus.CANCELLED },
    ]);
    const result = await detail();
    expect(result.actions[0].detail).toMatchObject({ status: 'CANCELLED' });
    expect(result.metrics.find((row) => row.key === 'pendingQuotes')?.value).toBe(0);
    expect(result.metrics.find((row) => row.key === 'resolvedQuotes')?.value).toBe(0);
  });

  it('keeps standalone quote requests and avoids counting a converted quote twice', async () => {
    quotes.mockResolvedValue([
      quote('standalone'),
      {
        ...quote('converted'),
        orderId: 'order',
        order: order(),
        status: QuoteStatus.CONVERTED_TO_ORDER,
      },
    ]);
    const result = await detail();
    expect(result.actions.map((row) => row.id).sort()).toEqual(['order', 'standalone']);
    expect(result.userCount).toBe(1);
    expect(result.metrics.find((row) => row.key === 'totalQuotes')?.value).toBe(2);
  });

  it('uses verified payment to resolve a legacy quote linked to an older order', async () => {
    orders.mockResolvedValue([]);
    quotes.mockResolvedValue([
      {
        ...quote(),
        orderId: 'older-order',
        order: order('older-order', QuotationStatus.PAYMENT_VERIFIED),
      },
    ]);
    expect((await detail()).actions[0].detail).toMatchObject({
      status: 'RESOLVED',
      orderId: 'older-order',
    });
  });

  it('counts customers once while keeping each of their submissions in the ledger', async () => {
    orders.mockResolvedValue([order('first'), order('second')]);
    const result = await detail();
    expect(result.userCount).toBe(1);
    expect(result.actions).toHaveLength(2);
    expect(result.metrics.find((row) => row.key === 'avgItemsPerQuote')?.value).toBe(2);
  });

  it('filters both sources by submission date in the selected reporting window', async () => {
    orders.mockImplementation((query: Query) =>
      Promise.resolve(
        inPeriod(
          [
            order('current'),
            { ...order('old'), createdAt: new Date('2026-09-07T23:59:59Z') },
            { ...order('next'), createdAt: new Date('2026-10-08T00:00:00Z') },
          ],
          query,
        ),
      ),
    );
    quotes.mockImplementation((query: Query) =>
      Promise.resolve(
        inPeriod(
          [
            { ...quote('start'), createdAt: new Date('2026-09-08T00:00:00Z') },
            { ...quote('old'), createdAt: new Date('2026-09-01T00:00:00Z') },
          ],
          query,
        ),
      ),
    );
    expect((await detail()).actions.map((row) => row.id).sort()).toEqual(['current', 'start']);
  });
});

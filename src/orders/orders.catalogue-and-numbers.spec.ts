import { BadRequestException } from '@nestjs/common';
import { Prisma, QuotationStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';
import { renderQuotationPdf } from './quotation-pdf.util';

jest.mock('./quotation-pdf.util', () => ({
  renderQuotationPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
}));

const customer = { id: 'customer-1', role: Role.CLIENT } as AuthenticatedUser;
const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;

const makeService = (prisma: Record<string, unknown>) =>
  new OrdersService(
    prisma as never,
    { delByPrefix: jest.fn() } as never,
    { get: jest.fn().mockReturnValue(60) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

describe('quotation PDF uses the recorded unit price and the billed area', () => {
  it('passes the order line’s own unit price, the supplied area and the pieces — nothing derived', async () => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          customerId: 'customer-1',
          quotationStatus: QuotationStatus.QUOTATION_SENT,
          quotationViewedAt: null,
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'ORD-X',
          createdAt: new Date(),
          currency: 'RWF',
          customer: { fullName: 'A', email: null, phone: null },
          // 3.1 m² asked for → 13 pieces of 0.25 m² = 3.25 m² billed at 88.5/m².
          items: [
            {
              requiredAreaSqm: 3.1,
              totalPieces: 13,
              unitPrice: 88.5,
              totalPrice: 287.63,
              product: {
                name: 'Tile',
                suitableFor: 'FLOOR',
                boxCoverageSqm: 1,
                piecesPerBox: 4,
                collection: { size: '50×50cm' },
              },
            },
          ],
          subtotal: 287.63,
          transportFee: 0,
          transportFeeNote: null,
          total: 287.63,
          delivery: null,
        }),
        updateMany: jest.fn(),
      },
    };
    await makeService(prisma).viewQuotation('o1', customer);
    const calls = (renderQuotationPdf as jest.Mock).mock.calls as [
      [{ items: Record<string, number>[] }],
    ];
    const input = calls[0][0];
    expect(input.items[0]).toEqual(
      expect.objectContaining({
        requestedAreaSqm: 3.1,
        billedAreaSqm: 3.25,
        totalPieces: 13,
        unitPrice: 88.5,
        totalPrice: 287.63,
      }),
    );
  });
});

describe('inactive products cannot be ordered', () => {
  const product = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'Old Tile',
    isActive: true,
    price: 100,
    boxCoverageSqm: 1,
    piecesPerBox: 4,
    quantityOnHandSqm: 100,
    reservedAreaSqm: 0,
    collection: { tileAreaSqm: 0.25 },
    ...over,
  });

  it('refuses to place an order for one, naming it', async () => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([product({ isActive: false })]) },
    };
    const service = makeService(prisma);
    const call = service.create(
      { type: 'PURCHASE', items: [{ productId: 'p1', areaSqm: 4 }] } as never,
      customer,
    );
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow('"Old Tile" is no longer available');
  });

  it('still says "not found" for an unknown product', async () => {
    const prisma = { product: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(
      makeService(prisma).create(
        { type: 'PURCHASE', items: [{ productId: 'nope', areaSqm: 4 }] } as never,
        customer,
      ),
    ).rejects.toThrow('could not be found');
  });

  describe('revising an order', () => {
    const order = (items: { productId: string }[]) => ({
      id: 'o1',
      status: 'PENDING',
      quotationStatus: QuotationStatus.AWAITING_REVIEW,
      reservationExpiresAt: new Date(),
      updatedAt: new Date(),
      items: items.map((item) => ({ ...item, totalPieces: 16, product: product() })),
    });

    it('refuses to add a deactivated product', async () => {
      const prisma = {
        order: { findUnique: jest.fn().mockResolvedValue(order([{ productId: 'other' }])) },
        product: { findMany: jest.fn().mockResolvedValue([product({ isActive: false })]) },
      };
      await expect(
        makeService(prisma).updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin),
      ).rejects.toThrow('"Old Tile" is no longer available');
    });

    it('lets the revision keep a line for a product that was deactivated after the order was placed', async () => {
      const prisma = {
        order: { findUnique: jest.fn().mockResolvedValue(order([{ productId: 'p1' }])) },
        product: { findMany: jest.fn().mockResolvedValue([product({ isActive: false })]) },
        $transaction: jest
          .fn()
          .mockRejectedValue(new Error('reached the write — validation passed')),
      };
      await expect(
        makeService(prisma).updateItems('o1', { items: [{ productId: 'p1', areaSqm: 4 }] }, admin),
      ).rejects.toThrow('reached the write');
    });
  });
});

const spyOnCreateOnce = (service: OrdersService) =>
  jest.spyOn(
    service as unknown as { createOnce: (...args: unknown[]) => Promise<unknown> },
    'createOnce',
  );

describe('order numbers', () => {
  const clash = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['orderNumber'] },
    });

  it('differ even when two orders are created in the same millisecond', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const service = makeService({});
    const numbers = new Set(
      Array.from({ length: 200 }, () =>
        (service as never as { generateOrderNumber(): string }).generateOrderNumber(),
      ),
    );
    jest.restoreAllMocks();
    expect(numbers.size).toBeGreaterThan(190);
    for (const number of numbers) expect(number).toMatch(/^ORD-[0-9A-Z]+-[0-9A-Z]{4}$/);
  });

  it('retries with a fresh number when the database reports a clash', async () => {
    const service = makeService({});
    const createOnce = spyOnCreateOnce(service)
      .mockRejectedValueOnce(clash())
      .mockResolvedValueOnce({ orderCreated: true });
    await expect(service.create({ items: [] } as never, customer)).resolves.toEqual({
      orderCreated: true,
    });
    expect(createOnce).toHaveBeenCalledTimes(2);
  });

  it('gives up after a handful of clashes instead of looping', async () => {
    const service = makeService({});
    const createOnce = spyOnCreateOnce(service).mockRejectedValue(clash());
    await expect(service.create({ items: [] } as never, customer)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(createOnce).toHaveBeenCalledTimes(5);
  });

  it('does not retry an unrelated unique violation', async () => {
    const service = makeService({});
    const other = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
    const createOnce = spyOnCreateOnce(service).mockRejectedValue(other);
    await expect(service.create({ items: [] } as never, customer)).rejects.toBe(other);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });
});

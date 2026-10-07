import { OrderType, Role } from '@prisma/client';
import { OrdersService } from './orders.service';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import type { CreateOrderDto } from './dto/create-order.dto';

describe('order submission quotation journey trigger', () => {
  const customer = { id: 'customer', role: Role.CLIENT } as AuthenticatedUser;
  const dto: CreateOrderDto = {
    type: OrderType.PURCHASE,
    items: [{ productId: 'tile', areaSqm: 1 }],
  };
  const recordJourneyEvent = jest.fn();
  const create = jest.fn();
  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    recordJourneyEvent.mockResolvedValue({});
    create.mockResolvedValue({ id: 'order', items: [] });
    const tx = { order: { create }, $executeRaw: jest.fn().mockResolvedValue(1) };
    service = new OrdersService(
      {
        product: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'tile',
              name: 'Tile',
              isActive: true,
              quantityOnHandSqm: 20,
              reservedAreaSqm: 0,
              price: 1000,
              boxCoverageSqm: 1,
              piecesPerBox: 4,
              collection: { tileAreaSqm: 0.25 },
            },
          ]),
        },
        $transaction: (run: (client: unknown) => unknown) => run(tx),
      } as never,
      { delByPrefix: jest.fn() } as never,
      { get: () => 60 } as never,
      { recordJourneyEvent } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('records a quotation request after the order commits', async () => {
    await expect(service.create(dto, customer)).resolves.toMatchObject({ orderCreated: true });
    expect(recordJourneyEvent).toHaveBeenCalledWith({
      userId: customer.id,
      sessionId: customer.id,
      stage: 'REQUESTED_QUOTATION',
      metadata: { orderId: 'order' },
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      recordJourneyEvent.mock.invocationCallOrder[0],
    );
  });

  it('does not record a request when order creation fails', async () => {
    create.mockRejectedValue(new Error('Database unavailable'));
    await expect(service.create(dto, customer)).rejects.toThrow('Database unavailable');
    expect(recordJourneyEvent).not.toHaveBeenCalled();
  });

  it('keeps a committed order successful when the analytics trigger fails', async () => {
    recordJourneyEvent.mockRejectedValueOnce(new Error('Analytics unavailable'));
    await expect(service.create(dto, customer)).resolves.toMatchObject({ orderCreated: true });
    expect(recordJourneyEvent).toHaveBeenCalledWith({
      userId: customer.id,
      sessionId: customer.id,
      stage: 'PLACED_ORDER',
      metadata: { orderId: 'order' },
    });
  });
});

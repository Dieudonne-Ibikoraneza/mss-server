import { JourneyStage, Role } from '@prisma/client';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.journeyStageDetail — negotiation content', () => {
  let prisma: {
    customerJourneyEvent: { findMany: jest.Mock };
    quoteRequest: { findMany: jest.Mock };
    order: { findMany: jest.Mock };
  };
  let service: AnalyticsService;

  beforeEach(() => {
    const at = new Date();
    prisma = {
      customerJourneyEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            sessionId: 's1',
            userId: 'u1',
            createdAt: at,
            metadata: {},
            user: {
              id: 'u1',
              fullName: 'A',
              email: 'a@x.rw',
              phone: null,
              role: Role.CLIENT,
              status: 'ACTIVE',
            },
          },
        ]),
      },
      quoteRequest: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'order-1',
            customerId: 'u1',
            orderNumber: 'ORD-1',
            updatedAt: at,
            messages: [{ body: 'the customer said something private', createdAt: at }],
          },
        ]),
      },
    };
    service = new AnalyticsService(prisma as never, {} as never);
  });

  const lastMessage = async (role?: Role) => {
    const result = await service.journeyStageDetail(JourneyStage.NEGOTIATED, undefined, role);
    const action = result.actions.find((row) => row.type === 'ORDER_NEGOTIATION');
    return (action?.detail as { lastMessage: string | null }).lastMessage;
  };

  it("hides a thread's last message from the data analyst", async () => {
    await expect(lastMessage(Role.DATA_ANALYST)).resolves.toBeNull();
  });

  it.each([Role.ADMIN, Role.STOCK_MANAGER])('still shows it to a %s', async (role) => {
    await expect(lastMessage(role)).resolves.toBe('the customer said something private');
  });

  it("keeps the analyst's aggregate negotiation counts and thread rows", async () => {
    const result = await service.journeyStageDetail(
      JourneyStage.NEGOTIATED,
      undefined,
      Role.DATA_ANALYST,
    );
    expect(result.metrics.find((metric) => metric.key === 'orderThreads')?.value).toBe(1);
    expect(result.actions.some((row) => row.type === 'ORDER_NEGOTIATION')).toBe(true);
  });
});

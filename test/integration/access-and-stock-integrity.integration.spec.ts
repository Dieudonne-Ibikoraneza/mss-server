import { OrderStatus, RoomType, Role, StockMovementType } from '@prisma/client';
import { ChatbotService } from '../../src/chatbot/chatbot.service';
import { ProductsService } from '../../src/products/products.service';
import { RoomsService } from '../../src/rooms/rooms.service';
import {
  createActors,
  createProduct,
  makeOrders,
  markPaymentSubmitted,
  orderState,
  outcome,
  placeOrder,
  prisma,
  productState,
  type Actors,
} from './harness';

const redisStub = { del: () => Promise.resolve(), delByPrefix: () => Promise.resolve() };

describe('access control and stock integrity (real database)', () => {
  let actors: Actors;
  beforeAll(async () => {
    actors = await createActors();
  });
  afterAll(() => prisma.$disconnect());

  const makeUser = (role: Role, label: string) =>
    prisma.user.create({
      data: {
        fullName: `IT ${label}`,
        email: `${label}${Date.now().toString(36)}@example.test`,
        phone: `+2507${(Date.now() % 10000000).toString().padStart(7, '0')}${Math.floor(Math.random() * 9)}`,
        role,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    });

  describe('room designs', () => {
    const rooms = new RoomsService(prisma as never, {} as never, {} as never, {} as never);
    // Tile serialisation needs storage; it is not what is under test.
    (rooms as unknown as { withSerializedTiles: (d: unknown) => unknown }).withSerializedTiles = (
      design,
    ) => design;

    const design = async (ownerId: string, sharedWithSales: boolean) => {
      const room = await prisma.room.create({
        data: { type: RoomType.BEDROOM, name: 'R', modelUrl: 'x' },
      });
      return prisma.roomDesign.create({
        data: { userId: ownerId, roomId: room.id, name: 'D', sharedWithSales },
      });
    };

    it('another customer can never read it — shared with sales or not', async () => {
      const owner = await makeUser(Role.CLIENT, 'owner');
      const stranger = await makeUser(Role.CLIENT, 'stranger');
      const shared = await design(owner.id, true);
      const priv = await design(owner.id, false);
      expect(await outcome(() => rooms.findDesign(shared.id, stranger.id, false))).toBe(
        'ForbiddenException',
      );
      expect(await outcome(() => rooms.findDesign(priv.id, stranger.id, false))).toBe(
        'ForbiddenException',
      );
    });

    it('staff read only designs the owner shared with sales', async () => {
      const owner = await makeUser(Role.CLIENT, 'owner2');
      const shared = await design(owner.id, true);
      const priv = await design(owner.id, false);
      expect(await outcome(() => rooms.findDesign(shared.id, actors.staff.id, true))).toBe('ok');
      expect(await outcome(() => rooms.findDesign(priv.id, actors.staff.id, true))).toBe(
        'ForbiddenException',
      );
    });

    it('the owner reads their own, and the owner record is only contact fields', async () => {
      const owner = await makeUser(Role.CLIENT, 'owner3');
      const priv = await design(owner.id, false);
      const seen = (await rooms.findDesign(priv.id, owner.id, false)) as {
        user: Record<string, unknown>;
      };
      expect(Object.keys(seen.user).sort()).toEqual(['email', 'fullName', 'id', 'phone']);
    });
  });

  describe('recommendation feedback', () => {
    const chatbot = Object.create(ChatbotService.prototype) as ChatbotService;
    (chatbot as unknown as { prisma: unknown }).prisma = prisma;

    it('only the customer it was made for can change it; anyone else gets "not found"', async () => {
      const product = await createProduct(actors, { onHand: 10 });
      const owner = await makeUser(Role.CLIENT, 'rec-owner');
      const other = await makeUser(Role.CLIENT, 'rec-other');
      const rec = await prisma.recommendation.create({
        data: {
          userId: owner.id,
          sessionId: 's',
          productId: product.id,
          rank: 1,
          matchScore: 90,
        },
      });

      expect(
        await outcome(() => chatbot.setRecommendationDecision(rec.id, 'REJECTED', other.id)),
      ).toBe('NotFoundException');
      expect(
        (await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).decision,
      ).toBe('PENDING');

      const result = await chatbot.setRecommendationDecision(rec.id, 'ACCEPTED', owner.id);
      expect(result).toEqual({ id: rec.id, decision: 'ACCEPTED' });
    });
  });

  describe("editing a product's packaging after checkout", () => {
    it('an existing order still reserves, deducts and returns what it was placed for', async () => {
      const orders = makeOrders();
      const product = await createProduct(actors, { onHand: 100 }); // 4 tiles of 0.25 m² per box
      const id = await placeOrder(orders, actors, product.id, 4); // 16 tiles = 4 m²
      expect((await productState(product.id)).reserved).toBe(4);

      // Someone edits the box: now 8 tiles covering 4 m² (0.5 m² a tile).
      await prisma.product.update({
        where: { id: product.id },
        data: { boxCoverageSqm: 4, piecesPerBox: 8 },
      });

      await orders.sendQuotation(id, { transportFee: 0 }, actors.staff);
      await markPaymentSubmitted(id);
      await orders.verifyPayment(id, actors.staff);
      // Payment verified: the reservation is released and 4 m² (not 8) leave the shelf.
      expect(await productState(product.id)).toEqual({ onHand: 96, reserved: 0 });

      await orders.updateStatus(id, { status: OrderStatus.CANCELLED }, actors.staff);
      expect(await productState(product.id)).toEqual({ onHand: 100, reserved: 0 });
      expect((await orderState(id)).status).toBe(OrderStatus.CANCELLED);
    });
  });

  describe('manual stock adjustments at the same moment', () => {
    const products = new ProductsService(
      prisma as never,
      redisStub as never,
      { notifyLowStock: () => Promise.resolve() } as never,
      {} as never,
      { promoteWaitlistedOrders: () => Promise.resolve() } as never,
      {} as never,
    );
    const adjust = (productId: string, changeAreaSqm: number, extra: object = {}) =>
      products.adjustStock(productId, { changeAreaSqm, reason: 'it', ...extra }, actors.staff.id);

    it('every adjustment reaches the stock as well as the ledger', async () => {
      const product = await createProduct(actors, { onHand: 0 });
      await Promise.all(Array.from({ length: 5 }, () => adjust(product.id, 5)));
      expect((await productState(product.id)).onHand).toBe(25);
      const ledger = await prisma.stockAdjustment.aggregate({
        where: { productId: product.id },
        _sum: { changeAreaSqm: true },
        _count: true,
      });
      expect(ledger._count).toBe(5);
      expect(Number(ledger._sum.changeAreaSqm)).toBe(25);
    });

    it('two removals that together exceed the stock: one succeeds, one is refused', async () => {
      const product = await createProduct(actors, { onHand: 10 });
      const results = await Promise.all([
        outcome(() => adjust(product.id, -8)),
        outcome(() => adjust(product.id, -8)),
      ]);
      expect(results.sort()).toEqual(['BadRequestException', 'ok']);
      expect((await productState(product.id)).onHand).toBe(2);
    });

    it('the average cost follows the real running quantity', async () => {
      const product = await createProduct(actors, { onHand: 0 });
      await adjust(product.id, 10, { costPrice: 10, type: StockMovementType.INBOUND });
      await Promise.all([
        adjust(product.id, 10, { costPrice: 20 }),
        adjust(product.id, 10, { costPrice: 30 }),
      ]);
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(Number(row.quantityOnHandSqm)).toBe(30);
      expect(Number(row.averageCostPrice)).toBeCloseTo((10 * 10 + 10 * 20 + 10 * 30) / 30, 4);
    });
  });
});

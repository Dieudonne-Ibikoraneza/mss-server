import { Logger, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import { Role } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '@/prisma/prisma.service';

type NegotiationKind = 'order' | 'cart';

interface JoinPayload {
  kind: NegotiationKind;
  id: string;
}

interface SocketUser {
  id: string;
  role: Role;
}

/**
 * `socket.data` is typed `any` by socket.io, and `any` swallows whatever it's
 * intersected with — `Omit` first so this actually narrows it to the one
 * shape this gateway ever puts there.
 */
type AppSocket = Omit<Socket, 'data'> & { data: { user?: SocketUser } };

const STAFF_ROLES: Role[] = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.ADMIN, Role.DATA_ANALYST];
const STAFF_ROOM = 'staff';

const roomOf = ({ kind, id }: JoinPayload) => `${kind}:${id}`;

/**
 * Instant delivery for negotiation chats (doc: cart shortages and over-stock
 * orders get a back-and-forth with the stock team). The REST endpoints
 * (`orders.service.ts#postMessage`, `cart-negotiations.service.ts#postMessage`)
 * remain the only way a message is created — this gateway never writes to the
 * database itself, it only fans a message out over a socket right after one of
 * those services persists it, and lets clients join the one thread (or, for
 * staff, the shared inbox room) they're allowed to see.
 *
 * One namespace, two room shapes:
 * - `order:<orderId>` / `cart:<negotiationId>` — the thread itself, joined by
 *   the customer it belongs to and by any staff member viewing it.
 * - `staff` — every staff connection, auto-joined on connect, for the
 *   negotiations inbox to reorder/highlight live without joining every thread.
 */
@UseFilters(BaseWsExceptionFilter)
@WebSocketGateway({
  namespace: '/negotiations',
  cors: {
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((o) => o.trim()),
    credentials: true,
  },
})
export class NegotiationsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(NegotiationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private isStaff(role: Role) {
    return STAFF_ROLES.includes(role);
  }

  /**
   * Runs as socket.io middleware — before the client's `connect` event fires
   * — rather than as `OnGatewayConnection.handleConnection`, which is async
   * but doesn't block anything: a client can (and reliably does, on a fast
   * loopback connection) fire `join` immediately on `connect`, arriving at
   * the gateway before an async `handleConnection` has finished verifying
   * the token. Middleware genuinely gates the connection on auth succeeding
   * first, so `client.data.user` is guaranteed set by the time any
   * `@SubscribeMessage` handler runs.
   */
  afterInit(server: Server) {
    server.use((socket: AppSocket, next) => {
      void (async () => {
        try {
          const token =
            (socket.handshake.auth?.token as string | undefined) ??
            (socket.handshake.query?.token as string | undefined);
          if (!token) throw new Error('Missing auth token.');

          const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
            secret: this.config.get<string>('jwt.accessSecret'),
          });
          const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
          if (!user || user.status !== 'ACTIVE') throw new Error('Account is not active.');

          socket.data.user = { id: user.id, role: user.role };
          next();
        } catch (error) {
          this.logger.warn(`Rejected socket connection: ${(error as Error).message}`);
          next(error as Error);
        }
      })();
    });
  }

  /** Staff auto-join the shared inbox room — safe to do post-`connect` since it gates nothing a client-initiated message depends on. */
  handleConnection(client: AppSocket) {
    const user = client.data.user;
    if (user && this.isStaff(user.role)) void client.join(STAFF_ROOM);
  }

  private async assertAccess(user: SocketUser, payload: JoinPayload) {
    if (payload.kind === 'order') {
      const order = await this.prisma.order.findUnique({ where: { id: payload.id } });
      if (!order) throw new WsException('Order not found.');
      if (!this.isStaff(user.role) && order.customerId !== user.id) {
        throw new WsException('You do not have access to this order.');
      }
      return;
    }

    const negotiation = await this.prisma.cartNegotiation.findUnique({ where: { id: payload.id } });
    if (!negotiation) throw new WsException('Negotiation not found.');
    if (!this.isStaff(user.role) && negotiation.customerId !== user.id) {
      throw new WsException('You do not have access to this negotiation.');
    }
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() client: AppSocket, @MessageBody() payload: JoinPayload) {
    const user = client.data.user;
    if (!user) throw new WsException('Not authenticated.');
    if (payload?.kind !== 'order' && payload?.kind !== 'cart') {
      throw new WsException('kind must be "order" or "cart".');
    }
    await this.assertAccess(user, payload);
    await client.join(roomOf(payload));
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async onLeave(@ConnectedSocket() client: AppSocket, @MessageBody() payload: JoinPayload) {
    await client.leave(roomOf(payload));
    return { ok: true };
  }

  /**
   * Called by `OrdersService`/`CartNegotiationsService` right after a message
   * is persisted — pushes it to whoever's in the thread, and nudges every
   * staff connection so the inbox list can reorder/highlight without polling.
   */
  emitMessage(kind: NegotiationKind, id: string, message: unknown) {
    this.server.to(roomOf({ kind, id })).emit('message', { kind, id, message });
    this.server.to(STAFF_ROOM).emit('thread-updated', { kind, id });
  }
}

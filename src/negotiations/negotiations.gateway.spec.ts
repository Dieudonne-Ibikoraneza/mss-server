import { Role } from '@prisma/client';
import { NegotiationsGateway } from './negotiations.gateway';

type Middleware = (socket: unknown, next: (error?: Error) => void) => void;

describe('NegotiationsGateway — socket auth', () => {
  let jwt: { verifyAsync: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };
  let middleware: Middleware;

  const connect = (role: Role) => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role, status: 'ACTIVE' });
    const socket = {
      handshake: { auth: { token: 't' }, query: {} },
      data: {} as { user?: unknown },
    };
    return new Promise<{ error?: Error; socket: typeof socket }>((resolve) => {
      middleware(socket, (error) => resolve({ error, socket }));
    });
  };

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1' }) };
    prisma = { user: { findUnique: jest.fn() } };
    const gateway = new NegotiationsGateway(
      jwt as never,
      { get: jest.fn().mockReturnValue('secret') } as never,
      prisma as never,
    );
    gateway.afterInit({ use: (fn: Middleware) => (middleware = fn) } as never);
  });

  it('rejects the data analyst before the connection completes', async () => {
    const { error, socket } = await connect(Role.DATA_ANALYST);
    expect(error?.message).toMatch(/not available for this role/i);
    expect(socket.data.user).toBeUndefined();
  });

  it.each([Role.STOCK_MANAGER, Role.ADMIN, Role.SALES_PERSON, Role.CLIENT])(
    'still lets a %s connect',
    async (role) => {
      const { error, socket } = await connect(role);
      expect(error).toBeUndefined();
      expect(socket.data.user).toEqual({ id: 'u1', role });
    },
  );

  it('never puts an analyst in the staff room', () => {
    const gateway = new NegotiationsGateway({} as never, {} as never, {} as never);
    const join = jest.fn();
    gateway.handleConnection({
      data: { user: { id: 'u1', role: Role.DATA_ANALYST } },
      join,
    } as never);
    expect(join).not.toHaveBeenCalled();
  });
});

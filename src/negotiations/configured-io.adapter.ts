import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO with the same allowed origins as the HTTP API.
 *
 * `@WebSocketGateway({ cors })` is read when the file is imported — before
 * `ConfigModule` has loaded `.env` — so origins configured there were silently
 * ignored and the gateway fell back to localhost. Building the server here, from
 * the resolved configuration, keeps HTTP and WebSocket CORS one setting.
 */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.allowedOrigins, credentials: true },
    }) as unknown;
  }
}

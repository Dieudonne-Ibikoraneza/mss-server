import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      // No `REDIS_URL` means no Redis at all (not "try localhost"): `RedisService` then falls
      // back to Postgres — see its class comment.
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url');
        return url ? new Redis(url, { maxRetriesPerRequest: 3 }) : null;
      },
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PrismaService } from '@/prisma/prisma.service';
import { KeyValueStore } from './key-value-store';
import { PostgresKeyValueStore } from './postgres-store';
import { REDIS_CLIENT } from './redis.constants';
import { RedisKeyValueStore } from './redis-store';

/**
 * Short-lived state (OTP codes, pending registrations, rate-limit-style counters, duplicate
 * suppression) plus an optional response cache.
 *
 * With `REDIS_URL` set, everything lives in Redis. With no Redis at all (e.g. a free hosting
 * tier), the state operations run against a Postgres table instead, and the response cache is
 * simply switched off — every request then reads Postgres directly.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly store: KeyValueStore;
  private readonly postgresStore: PostgresKeyValueStore | null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis | null,
    @Optional() prisma?: PrismaService,
  ) {
    if (client) {
      this.store = new RedisKeyValueStore(client);
      this.postgresStore = null;
    } else if (prisma) {
      this.postgresStore = new PostgresKeyValueStore(prisma);
      this.store = this.postgresStore;
      this.logger.warn(
        'REDIS_URL is not set — keeping OTP/dedup state in Postgres and running without a response cache.',
      );
    } else {
      throw new Error('RedisService needs either a Redis client or a PrismaService.');
    }
  }

  // --- State (works on either backend) -------------------------------------

  async get<T = string>(key: string): Promise<T | null> {
    const value = await this.store.get(key);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.store.set(
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
      ttlSeconds,
    );
  }

  /** Atomically claims a short-lived key. Useful for replay and duplicate suppression. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    return this.store.setIfAbsent(key, payload, ttlSeconds);
  }

  /** How many live keys were removed (0 or 1). */
  del(key: string): Promise<number> {
    return this.store.del(key);
  }

  incr(key: string, ttlSeconds?: number): Promise<number> {
    return this.store.incr(key, ttlSeconds);
  }

  ttl(key: string): Promise<number> {
    return this.store.ttl(key);
  }

  // --- Response cache (Redis only; without it every read is a cache miss) ---

  cacheGet<T = string>(key: string): Promise<T | null> {
    return this.client ? this.get<T>(key) : Promise.resolve(null);
  }

  async cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (this.client) await this.set(key, value, ttlSeconds);
  }

  async cacheDel(key: string): Promise<void> {
    if (this.client) await this.client.del(key);
  }

  /** Deletes every cached key starting with `prefix`, via SCAN so it never blocks Redis on a large keyspace. */
  async cacheDelByPrefix(prefix: string): Promise<void> {
    if (!this.client) return;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /** Reads already ignore expired Postgres rows; this only stops the table growing. */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpired(): Promise<void> {
    if (!this.postgresStore) return;
    try {
      await this.postgresStore.deleteExpired();
    } catch (error) {
      this.logger.warn(
        `Could not clear expired state rows: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

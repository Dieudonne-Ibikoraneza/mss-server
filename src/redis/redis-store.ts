import Redis from 'ioredis';
import { KeyValueStore } from './key-value-store';

export class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly client: Redis) {}

  get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, payload: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.client.set(key, payload, 'EX', ttlSeconds);
    else await this.client.set(key, payload);
  }

  async setIfAbsent(key: string, payload: string, ttlSeconds: number) {
    return (await this.client.set(key, payload, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  del(key: string) {
    return this.client.del(key);
  }

  async incr(key: string, ttlSeconds?: number) {
    const count = await this.client.incr(key);
    if (count === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return count;
  }

  ttl(key: string) {
    return this.client.ttl(key);
  }
}

import { PostgresKeyValueStore } from '../../src/redis/postgres-store';
import { RedisService } from '../../src/redis/redis.service';
import { prisma } from './harness';

/**
 * With no Redis, short-lived state lives in one Postgres table. These pin the properties the
 * app relies on: expiry, and exactly-one-winner under simultaneous callers.
 */
describe('Postgres stand-in for Redis (no REDIS_URL)', () => {
  const store = new PostgresKeyValueStore(prisma as never);
  const redis = new RedisService(null, prisma as never);
  const id = `it-kv-${Date.now().toString(36)}`;
  const k = (name: string) => `${id}:${name}`;

  afterAll(async () => {
    await prisma.keyValueEntry.deleteMany({ where: { key: { startsWith: id } } });
  });

  const expireNow = (key: string) =>
    prisma.keyValueEntry.update({
      where: { key },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

  it('stores and reads back JSON, strings and no-TTL values', async () => {
    await redis.set(k('json'), { a: 1, nested: ['x'] }, 60);
    await redis.set(k('str'), 'hello');
    expect(await redis.get(k('json'))).toEqual({ a: 1, nested: ['x'] });
    expect(await redis.get(k('str'))).toBe('hello');
    expect(await redis.get(k('missing'))).toBeNull();
    expect(await redis.ttl(k('str'))).toBe(-1);
    expect(await redis.ttl(k('missing'))).toBe(-2);
    const ttl = await redis.ttl(k('json'));
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('an expired value reads as absent, and can be claimed again', async () => {
    await redis.set(k('expiring'), 'v', 60);
    await expireNow(k('expiring'));
    expect(await redis.get(k('expiring'))).toBeNull();
    expect(await redis.ttl(k('expiring'))).toBe(-2);
    expect(await redis.del(k('expiring'))).toBe(0); // nothing live to remove
    await redis.set(k('claim'), 'old', 60);
    await expireNow(k('claim'));
    expect(await redis.setIfAbsent(k('claim'), 'new', 60)).toBe(true);
    expect(await redis.get(k('claim'))).toBe('new');
  });

  it('of many simultaneous claims on one key, exactly one wins', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => redis.setIfAbsent(k('race'), '1', 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await redis.setIfAbsent(k('race'), '1', 60)).toBe(false);
  });

  it('del reports whether it removed a live key, so only one caller can consume a code', async () => {
    await redis.set(k('once'), 'code', 60);
    const results = await Promise.all(Array.from({ length: 20 }, () => redis.del(k('once'))));
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1);
  });

  it('incr counts every simultaneous increment and keeps the first expiry', async () => {
    const counts = await Promise.all(
      Array.from({ length: 25 }, () => redis.incr(k('counter'), 60)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const before = await redis.ttl(k('counter'));
    await redis.incr(k('counter'), 9999); // a later ttl must not extend the window
    expect(await redis.ttl(k('counter'))).toBeLessThanOrEqual(before);

    // an expired counter starts again from 1
    await expireNow(k('counter'));
    expect(await redis.incr(k('counter'), 60)).toBe(1);
  });

  it('the hourly sweep removes expired rows and leaves live ones', async () => {
    await redis.set(k('stale'), 'x', 60);
    await expireNow(k('stale'));
    await redis.set(k('fresh'), 'y', 60);
    await store.deleteExpired();
    expect(await prisma.keyValueEntry.findUnique({ where: { key: k('stale') } })).toBeNull();
    expect(await prisma.keyValueEntry.findUnique({ where: { key: k('fresh') } })).not.toBeNull();
  });

  it('the response cache is off: reads always miss and writes store nothing', async () => {
    await redis.cacheSet(k('cached'), { big: 'payload' }, 300);
    expect(await redis.cacheGet(k('cached'))).toBeNull();
    expect(await prisma.keyValueEntry.findUnique({ where: { key: k('cached') } })).toBeNull();
    await expect(redis.cacheDelByPrefix(k(''))).resolves.toBeUndefined();
    await expect(redis.cacheDel(k('cached'))).resolves.toBeUndefined();
  });
});

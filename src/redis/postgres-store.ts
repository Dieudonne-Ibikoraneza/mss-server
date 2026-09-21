import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { KeyValueStore } from './key-value-store';

/**
 * `KeyValueEntry.expiresAt` is a `TIMESTAMP(3)` holding UTC (Prisma's convention), so every
 * comparison and every new expiry is computed by the database itself, in UTC — never from the
 * app server's clock, which could disagree with it.
 */
const NOW = Prisma.sql`timezone('UTC', now())`;
const expiresIn = (ttlSeconds?: number) =>
  ttlSeconds
    ? Prisma.sql`(${NOW} + ${ttlSeconds}::double precision * interval '1 second')`
    : Prisma.sql`NULL`;
const LIVE = Prisma.sql`("expiresAt" IS NULL OR "expiresAt" > ${NOW})`;
const EXISTING_EXPIRED = Prisma.sql`("KeyValueEntry"."expiresAt" IS NOT NULL AND "KeyValueEntry"."expiresAt" <= ${NOW})`;

/** Same guarantees as the Redis commands they stand in for — each is one atomic SQL statement. */
export class PostgresKeyValueStore implements KeyValueStore {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: string) {
    const rows = await this.prisma.$queryRaw<{ value: string }[]>(
      Prisma.sql`SELECT "value" FROM "KeyValueEntry" WHERE "key" = ${key} AND ${LIVE}`,
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, payload: string, ttlSeconds?: number) {
    await this.prisma.$executeRaw(
      Prisma.sql`INSERT INTO "KeyValueEntry" ("key", "value", "expiresAt")
        VALUES (${key}, ${payload}, ${expiresIn(ttlSeconds)})
        ON CONFLICT ("key") DO UPDATE
        SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"`,
    );
  }

  /**
   * The conflict branch only fires for a row that has already expired, so of any number of
   * simultaneous callers exactly one gets a row back — the rest wait on the row lock, re-check
   * the condition against the winner's fresh row, and update nothing.
   */
  async setIfAbsent(key: string, payload: string, ttlSeconds: number) {
    const rows = await this.prisma.$queryRaw<{ key: string }[]>(
      Prisma.sql`INSERT INTO "KeyValueEntry" ("key", "value", "expiresAt")
        VALUES (${key}, ${payload}, ${expiresIn(ttlSeconds)})
        ON CONFLICT ("key") DO UPDATE
        SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"
        WHERE ${EXISTING_EXPIRED}
        RETURNING "key"`,
    );
    return rows.length === 1;
  }

  del(key: string) {
    return this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM "KeyValueEntry" WHERE "key" = ${key} AND ${LIVE}`,
    );
  }

  async incr(key: string, ttlSeconds?: number) {
    const rows = await this.prisma.$queryRaw<{ value: string }[]>(
      Prisma.sql`INSERT INTO "KeyValueEntry" ("key", "value", "expiresAt")
        VALUES (${key}, '1', ${expiresIn(ttlSeconds)})
        ON CONFLICT ("key") DO UPDATE
        SET "value" = CASE WHEN ${EXISTING_EXPIRED} THEN '1'
                           ELSE ("KeyValueEntry"."value"::bigint + 1)::text END,
            "expiresAt" = CASE WHEN ${EXISTING_EXPIRED} THEN EXCLUDED."expiresAt"
                               ELSE "KeyValueEntry"."expiresAt" END
        RETURNING "value"`,
    );
    return Number(rows[0].value);
  }

  async ttl(key: string) {
    const rows = await this.prisma.$queryRaw<{ ttl: number }[]>(
      Prisma.sql`SELECT CASE WHEN "expiresAt" IS NULL THEN -1
                             ELSE ceil(extract(epoch FROM ("expiresAt" - ${NOW})))::int END AS "ttl"
        FROM "KeyValueEntry" WHERE "key" = ${key} AND ${LIVE}`,
    );
    return rows[0]?.ttl ?? -2;
  }

  /** Reads already ignore expired rows; this only keeps the table from growing. */
  async deleteExpired() {
    return this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM "KeyValueEntry" WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= ${NOW}`,
    );
  }
}

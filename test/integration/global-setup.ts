import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';

const SERVER_ROOT = path.resolve(__dirname, '../..');

const withSchema = (url: string, schema: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
};

/**
 * The integration tests run against real Postgres, but never against real
 * data: every run builds its own throwaway schema (`it_<id>`) on the database
 * `DATABASE_URL` points at, applies every migration into it, and drops it
 * again in `global-teardown.ts`. Nothing outside that schema is read or written.
 */
export default function globalSetup() {
  dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set — the integration tests need a Postgres to build a throwaway schema in.',
    );
  }
  const directUrl = process.env.DIRECT_URL ?? databaseUrl;
  const schema = `it_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const url = withSchema(databaseUrl, schema);

  process.env.IT_DATABASE_URL = url;
  process.env.IT_SCHEMA = schema;
  // `migrate deploy` reads DIRECT_URL (see the datasource in schema.prisma), so
  // both must point into the throwaway schema or it would migrate the real one.
  execSync('npx prisma migrate deploy', {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: withSchema(directUrl, schema) },
    stdio: 'pipe',
  });
}

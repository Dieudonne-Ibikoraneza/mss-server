import { PrismaClient } from '@prisma/client';

/** Drops the throwaway schema `global-setup.ts` built. */
export default async function globalTeardown() {
  const url = process.env.IT_DATABASE_URL;
  const schema = process.env.IT_SCHEMA;
  if (!url || !schema) return;
  // Only ever drops a schema this suite created.
  if (!/^it_[a-z0-9_]+$/.test(schema)) throw new Error(`Refusing to drop schema "${schema}"`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * One-off sweep that fills in the `*Rw` columns
 * for every Product/Collection/Room that predates
 * the translation feature (see `src/translation/`) — new/edited rows are
 * translated automatically going forward by the services themselves; this
 * is only for the backlog that already existed.
 *
 * Requires TRANSLATE_PROVIDER=google and a real GOOGLE_TRANSLATE_API_KEY in
 * .env — with TRANSLATE_PROVIDER left at "stub" this is a safe no-op (every
 * row is skipped, since the field only ever comes back empty).
 *
 * Run with: npm run translate:backfill
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GOOGLE_TRANSLATE_API_URL = 'https://translation.googleapis.com/language/translate2';
/** Google's v2 API accepts many `q` values per request — batching keeps this to a handful of calls instead of one per row/field. */
const BATCH_SIZE = 100;

const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY ?? '';
const provider = process.env.TRANSLATE_PROVIDER ?? 'stub';

/**
 * `null` in the result means "not translated" — a missing/partial API
 * response never falls back to the original English text, since that would
 * write English into an `*Rw` column looking exactly like a real
 * translation, permanently hiding that row from a future re-run.
 */
async function translateBatch(texts: string[]): Promise<(string | null)[]> {
  if (texts.length === 0) return [];
  if (provider !== 'google' || !apiKey) return texts.map(() => null);

  const response = await fetch(`${GOOGLE_TRANSLATE_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target: 'rw', format: 'text' }),
  });
  if (!response.ok) {
    throw new Error(`Google Translate API error: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: { translations?: { translatedText?: string }[] };
  };
  const translations = payload.data?.translations;
  if (!translations || translations.length !== texts.length) {
    throw new Error('Google Translate API returned an unexpected shape.');
  }
  return translations.map((row) => row.translatedText ?? null);
}

/** Translates `texts` in chunks of `BATCH_SIZE`, in order. */
async function translateAll(texts: string[]): Promise<(string | null)[]> {
  const results: (string | null)[] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const chunk = texts.slice(start, start + BATCH_SIZE);
    results.push(...(await translateBatch(chunk)));
  }
  return results;
}

async function backfillProducts() {
  const products = await prisma.product.findMany({
    where: {
      OR: [{ nameRw: null }, { AND: [{ description: { not: null } }, { descriptionRw: null }] }],
    },
    select: { id: true, name: true, description: true },
  });
  if (products.length === 0) {
    console.log('Products: nothing to translate.');
    return;
  }

  const names = await translateAll(products.map((p) => p.name));
  const descriptions = await translateAll(products.map((p) => p.description ?? ''));

  for (let i = 0; i < products.length; i++) {
    await prisma.product.update({
      where: { id: products[i].id },
      data: {
        nameRw: names[i],
        descriptionRw: products[i].description ? descriptions[i] : null,
      },
    });
  }
  console.log(`Products: translated ${products.length}.`);
}

async function backfillCollections() {
  const collections = await prisma.collection.findMany({
    where: {
      OR: [{ titleRw: null }, { AND: [{ description: { not: null } }, { descriptionRw: null }] }],
    },
    select: { id: true, title: true, description: true },
  });
  if (collections.length === 0) {
    console.log('Collections: nothing to translate.');
    return;
  }

  const titles = await translateAll(collections.map((c) => c.title));
  const descriptions = await translateAll(collections.map((c) => c.description ?? ''));

  for (let i = 0; i < collections.length; i++) {
    await prisma.collection.update({
      where: { id: collections[i].id },
      data: {
        titleRw: titles[i],
        descriptionRw: collections[i].description ? descriptions[i] : null,
      },
    });
  }
  console.log(`Collections: translated ${collections.length}.`);
}

async function backfillRooms() {
  const rooms = await prisma.room.findMany({
    where: {
      OR: [{ nameRw: null }, { AND: [{ description: { not: null } }, { descriptionRw: null }] }],
    },
    select: { id: true, name: true, description: true },
  });
  if (rooms.length === 0) {
    console.log('Rooms: nothing to translate.');
    return;
  }

  const names = await translateAll(rooms.map((r) => r.name));
  const descriptions = await translateAll(rooms.map((r) => r.description ?? ''));

  for (let i = 0; i < rooms.length; i++) {
    await prisma.room.update({
      where: { id: rooms[i].id },
      data: {
        nameRw: names[i],
        descriptionRw: rooms[i].description ? descriptions[i] : null,
      },
    });
  }
  console.log(`Rooms: translated ${rooms.length}.`);
}

async function main() {
  // Deliberately exits before touching any row rather than falling through
  // and writing untranslated English into the `*Rw` columns — that would
  // look like "already translated" to every future run (this one included)
  // and to every read that checks `nameRw !== null`, permanently masking
  // the real gap instead of just leaving it for later.
  if (provider !== 'google' || !apiKey) {
    console.warn(
      'TRANSLATE_PROVIDER is not "google" (or GOOGLE_TRANSLATE_API_KEY is unset) — ' +
        'nothing to do. Set both in .env to actually translate, then re-run this script.',
    );
    return;
  }

  await backfillProducts();
  await backfillCollections();
  await backfillRooms();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

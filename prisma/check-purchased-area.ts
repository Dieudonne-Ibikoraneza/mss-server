/**
 * Read-only check of `OrderItem.purchasedAreaSqm` — run it after `prisma migrate deploy`
 * (`npm run check:purchased-area`). The migration filled the column for existing orders from each
 * product's packaging *as it is today*. If a product's box size was edited before the migration
 * ran, its older orders got a wrong snapshot. This lists the lines that look wrong; it changes
 * nothing, so review the output before fixing anything by hand.
 *
 * A line is suspicious when:
 *  A. the billed area is smaller than the requested area (a piece cannot shrink the order), or
 *  B. the billed area exceeds the request by a whole piece or more (rounding adds < 1 piece), or
 *  C. the order's stock was deducted (`stockDeductedAt`) and the OUTBOUND movement recorded at
 *     that time differs from the snapshot — the ledger is what really left the shelf.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Row = Record<string, string | number | bigint>;
const show = (title: string, rows: Row[]) => {
  console.log(`\n${title}: ${rows.length}`);
  for (const row of rows.slice(0, 50))
    console.log(
      ' ',
      JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    );
  if (rows.length > 50) console.log(`  … and ${rows.length - 50} more`);
};

async function main() {
  const [{ count }] = await prisma.$queryRaw<
    { count: bigint }[]
  >`SELECT COUNT(*) AS count FROM "OrderItem"`;
  console.log(`Checking ${Number(count)} order lines.`);

  const tooSmall = await prisma.$queryRaw<Row[]>`
    SELECT o."orderNumber", p."name" AS product, oi."requiredAreaSqm" AS requested, oi."purchasedAreaSqm" AS billed
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
    WHERE oi."purchasedAreaSqm" < oi."requiredAreaSqm" - 0.0001`;
  show('A. billed area smaller than requested', tooSmall);

  const tooBig = await prisma.$queryRaw<Row[]>`
    SELECT o."orderNumber", p."name" AS product, oi."requiredAreaSqm" AS requested, oi."purchasedAreaSqm" AS billed,
           oi."totalPieces" AS pieces
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
    WHERE oi."totalPieces" > 0
      AND oi."purchasedAreaSqm" - oi."requiredAreaSqm" >= oi."purchasedAreaSqm" / oi."totalPieces" + 0.0001`;
  show('B. billed area a whole piece or more above the request', tooBig);

  const ledger = await prisma.$queryRaw<Row[]>`
    SELECT o."orderNumber", p."name" AS product, SUM(oi."purchasedAreaSqm") AS snapshot,
           -COALESCE((SELECT SUM(sa."changeAreaSqm") FROM "StockAdjustment" sa
                      WHERE sa."reference" = o."orderNumber" AND sa."productId" = oi."productId"
                        AND sa."type" = 'OUTBOUND'), 0) AS deducted
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
    WHERE o."stockDeductedAt" IS NOT NULL
    GROUP BY o."orderNumber", p."name", oi."productId"
    HAVING ABS(SUM(oi."purchasedAreaSqm") - (-COALESCE((SELECT SUM(sa."changeAreaSqm") FROM "StockAdjustment" sa
                      WHERE sa."reference" = o."orderNumber" AND sa."productId" = oi."productId"
                        AND sa."type" = 'OUTBOUND'), 0))) > 0.0001`;
  show('C. snapshot differs from the stock actually deducted', ledger);

  const flagged = tooSmall.length + tooBig.length + ledger.length;
  console.log(flagged === 0 ? '\nNothing suspicious.' : `\n${flagged} finding(s) to review.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

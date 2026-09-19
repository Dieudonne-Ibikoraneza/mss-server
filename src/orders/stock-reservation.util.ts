import { Prisma } from '@prisma/client';

/** Thrown when a reservation would exceed what is still available — the surrounding transaction must roll back. */
export class InsufficientStockError extends Error {
  constructor() {
    super('Stock was taken by another order before this reservation could be made.');
    this.name = 'InsufficientStockError';
  }
}

/**
 * Adds to `reservedAreaSqm` only where the product still has room, decided
 * inside the UPDATE itself (`on hand − reserved >= delta`). A "read
 * availability, then reserve" sequence lets two concurrent orders both see
 * the last sliver of stock and both take it; here Postgres locks each row,
 * and the loser re-evaluates the condition against the winner's committed
 * value and simply doesn't match.
 *
 * Same-product entries are netted first. A net release (`delta <= 0`) always
 * applies, so callers can mix "release old hold" and "reserve new" in one call
 * (`updateItems`). Throws `InsufficientStockError` if any product didn't match
 * — the caller's transaction must roll back, as the statement may already
 * have updated the other rows.
 */
export async function reserveAreaAtomically(
  tx: Prisma.TransactionClient,
  adjustments: { productId: string; deltaAreaSqm: number }[],
): Promise<void> {
  const netByProduct = new Map<string, number>();
  for (const { productId, deltaAreaSqm } of adjustments) {
    if (deltaAreaSqm === 0) continue;
    netByProduct.set(productId, (netByProduct.get(productId) ?? 0) + deltaAreaSqm);
  }
  const entries = [...netByProduct.entries()]
    .filter(([, delta]) => delta !== 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return;

  const rows = Prisma.join(
    entries.map(([productId, delta]) => Prisma.sql`(${productId}::text, ${delta}::numeric)`),
  );
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "Product" AS p
    SET "reservedAreaSqm" = p."reservedAreaSqm" + v."delta"
    FROM (VALUES ${rows}) AS v("id", "delta")
    WHERE p."id" = v."id"
      AND (v."delta" <= 0 OR p."quantityOnHandSqm" - p."reservedAreaSqm" >= v."delta")
  `);
  if (updated !== entries.length) throw new InsufficientStockError();
}

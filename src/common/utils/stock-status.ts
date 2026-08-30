import { Role } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** Mirrors the client's own `stockLabels` (product-card.tsx) — the only wording a non-staff viewer should ever see for stock. */
export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

/**
 * Exact stock counts and cost figures are staff-only everywhere in the app
 * (doc 3.2) — clients and anonymous/public callers only ever see `stockStatus`.
 */
export const canSeeExactStock = (role?: Role): boolean =>
  role === Role.ADMIN ||
  role === Role.STOCK_MANAGER ||
  role === Role.SALES_PERSON ||
  role === Role.DATA_ANALYST;

/**
 * Client-facing availability only — never expose the exact quantity to
 * clients. Both arguments are in square metres, the unit stock is now held
 * and moved in (`Product.quantityOnHandSqm`) — never pieces or boxes.
 */
export const stockStatusOf = (
  quantityOnHandSqm: number,
  lowStockThreshold: number,
): StockStatus => {
  if (quantityOnHandSqm <= 0) return 'out_of_stock';
  if (quantityOnHandSqm <= lowStockThreshold) return 'low_stock';
  return 'in_stock';
};

/**
 * The low-stock threshold is one GLOBAL number, in square metres
 * (admin-configurable via `PATCH /settings`), not a per-product field —
 * every product is compared against the same value. Read directly via
 * Prisma (not `SettingsService`) so callers don't need to import the whole
 * settings module just for this.
 */
export const LOW_STOCK_THRESHOLD_SETTING = 'stock.lowStockThreshold';
const DEFAULT_LOW_STOCK_THRESHOLD = 20;

export async function getLowStockThreshold(prisma: PrismaService): Promise<number> {
  const row = await prisma.platformSetting.findUnique({
    where: { key: LOW_STOCK_THRESHOLD_SETTING },
  });
  const value = row?.value;
  return typeof value === 'number' ? value : DEFAULT_LOW_STOCK_THRESHOLD;
}

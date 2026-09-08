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
 * What's actually left to sell: on-hand minus whatever other PENDING orders
 * are still holding during their payment window (`Order.reservationExpiresAt`
 * / `Product.reservedAreaSqm` — see `OrdersService`). Physical stock never
 * moves for a reservation, only this derived figure, so a second customer
 * can't buy square metres someone else's unpaid order is already holding.
 * Clamped at 0 — a reservation placed by staff overriding a shortage can push
 * `reservedAreaSqm` past `quantityOnHandSqm`.
 */
export const availableAreaSqmOf = (quantityOnHandSqm: number, reservedAreaSqm: number): number =>
  Math.max(0, quantityOnHandSqm - reservedAreaSqm);

/**
 * The low-stock threshold is one GLOBAL number, in square metres
 * (admin-configurable via `PATCH /settings`), not a per-product field —
 * every product is compared against the same value. Read directly via
 * Prisma (not `SettingsService`) so callers don't need to import the whole
 * settings module just for this.
 */
export const LOW_STOCK_THRESHOLD_SETTING = 'stock.lowStockThreshold';
const DEFAULT_LOW_STOCK_THRESHOLD = 20;

/**
 * This one number is read on nearly every products/orders/chatbot/analytics
 * request (every `stockStatusOf` call needs it) — over a database reached
 * across the network rather than localhost, that's a whole extra round trip
 * per request for a value that only ever changes via an admin editing
 * settings. A short in-process cache trades a few seconds of staleness on
 * that admin edit for cutting this query out of the hot path everywhere
 * else. Module-level (not per-request or per-instance) on purpose — cheap,
 * and every process converges within one TTL window regardless.
 */
const THRESHOLD_CACHE_TTL_MS = 15_000;
let cachedThreshold: { value: number; expiresAt: number } | null = null;

export async function getLowStockThreshold(prisma: PrismaService): Promise<number> {
  if (cachedThreshold && cachedThreshold.expiresAt > Date.now()) {
    return cachedThreshold.value;
  }
  const row = await prisma.platformSetting.findUnique({
    where: { key: LOW_STOCK_THRESHOLD_SETTING },
  });
  const value = row?.value;
  const threshold = typeof value === 'number' ? value : DEFAULT_LOW_STOCK_THRESHOLD;
  cachedThreshold = { value: threshold, expiresAt: Date.now() + THRESHOLD_CACHE_TTL_MS };
  return threshold;
}

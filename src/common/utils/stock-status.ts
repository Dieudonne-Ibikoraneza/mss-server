export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** Client-facing availability only — never expose the exact quantity to clients. */
export const stockStatusOf = (quantityOnHand: number, lowStockThreshold: number): StockStatus => {
  if (quantityOnHand <= 0) return 'out_of_stock';
  if (quantityOnHand <= lowStockThreshold) return 'low_stock';
  return 'in_stock';
};

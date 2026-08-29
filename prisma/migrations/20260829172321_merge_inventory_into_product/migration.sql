-- Merge Inventory into Product (one product table, no separate inventory
-- table) and drop stock reservation entirely — the low-stock threshold moves
-- to a single global PlatformSetting ("stock.lowStockThreshold") instead of
-- a per-product column.

ALTER TABLE "Product" ADD COLUMN "quantityOnHand" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "averageCostPrice" DECIMAL(12,4) NOT NULL DEFAULT 0;

UPDATE "Product" p
SET "quantityOnHand" = i."quantityOnHand",
    "averageCostPrice" = i."averageCostPrice"
FROM "Inventory" i
WHERE i."productId" = p."id";

DROP TABLE "Inventory";

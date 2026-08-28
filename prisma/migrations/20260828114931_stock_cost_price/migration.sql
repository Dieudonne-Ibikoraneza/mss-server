-- Moving weighted-average cost per piece, used for real inventory valuation
-- (instead of valuing stock at the selling price).
ALTER TABLE "Inventory" ADD COLUMN "averageCostPrice" DECIMAL(12,4) NOT NULL DEFAULT 0;

-- Per-batch cost (per box) and a snapshot of the average right after the
-- movement, for audit trail on stock-in movements that report a cost.
ALTER TABLE "StockAdjustment" ADD COLUMN "costPrice" DECIMAL(12,4);
ALTER TABLE "StockAdjustment" ADD COLUMN "averageCostAfter" DECIMAL(12,4);

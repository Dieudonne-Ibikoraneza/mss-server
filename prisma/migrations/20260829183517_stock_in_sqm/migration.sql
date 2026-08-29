-- Stock is now held and moved in square metres, matching how it's priced and
-- sold; boxes/pieces stay purely a display conversion (`calculateTileQuantity`).

-- Product: quantityOnHand (pieces) -> quantityOnHandSqm (m²), and
-- averageCostPrice moves from "per piece" to "per m²" to match.
ALTER TABLE "Product" ADD COLUMN "quantityOnHandSqm" DECIMAL(12,4);

UPDATE "Product"
SET
  "quantityOnHandSqm" = "quantityOnHand" * ("boxCoverageSqm" / "piecesPerBox"),
  "averageCostPrice" = "averageCostPrice" * "piecesPerBox" / "boxCoverageSqm";

ALTER TABLE "Product" ALTER COLUMN "quantityOnHandSqm" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "quantityOnHandSqm" SET DEFAULT 0;
ALTER TABLE "Product" DROP COLUMN "quantityOnHand";

-- StockAdjustment: changeQty (signed pieces) -> changeAreaSqm (signed m²).
-- No existing rows to convert at migration time.
ALTER TABLE "StockAdjustment" ADD COLUMN "changeAreaSqm" DECIMAL(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "StockAdjustment" ALTER COLUMN "changeAreaSqm" DROP DEFAULT;
ALTER TABLE "StockAdjustment" DROP COLUMN "changeQty";

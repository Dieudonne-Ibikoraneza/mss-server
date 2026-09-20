-- The area a line ships is fixed when the order is placed, so later edits to a product's
-- packaging cannot change what an existing order reserves, deducts, returns or bills.
ALTER TABLE "OrderItem" ADD COLUMN "purchasedAreaSqm" DECIMAL(14,6);

-- Existing lines: what they would have shipped under the packaging as it is today.
UPDATE "OrderItem" AS oi
SET "purchasedAreaSqm" = oi."totalPieces" * p."boxCoverageSqm" / p."piecesPerBox"
FROM "Product" AS p
WHERE p."id" = oi."productId";

ALTER TABLE "OrderItem" ALTER COLUMN "purchasedAreaSqm" SET NOT NULL;

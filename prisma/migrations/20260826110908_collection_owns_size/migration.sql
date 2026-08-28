-- Step 1: rename Collection.sizeLabel -> Collection.size, add tileAreaSqm (nullable for now, backfilled next)
ALTER TABLE "Collection" RENAME COLUMN "sizeLabel" TO "size";
ALTER TABLE "Collection" ADD COLUMN "tileAreaSqm" DECIMAL(10,4);

-- Step 2: backfill Collection.tileAreaSqm from any product that already has this collectionId
UPDATE "Collection" c
SET "tileAreaSqm" = p."tileAreaSqm"
FROM "Product" p
WHERE p."collectionId" = c.id;

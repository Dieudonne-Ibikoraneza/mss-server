-- Replace ProfilingQuestion.roomType (single, nullable) with roomTypes
-- (RoomType[], default '{}') so a question can be conditional on more than
-- one room type. Existing single values are preserved as one-element arrays;
-- a null roomType becomes an empty array (still "always asked").

-- AlterTable: add the new column
ALTER TABLE "ProfilingQuestion" ADD COLUMN "roomTypes" "RoomType"[] NOT NULL DEFAULT '{}';

-- Backfill from the old column
UPDATE "ProfilingQuestion"
SET "roomTypes" = ARRAY["roomType"]::"RoomType"[]
WHERE "roomType" IS NOT NULL;

-- Drop the old column
ALTER TABLE "ProfilingQuestion" DROP COLUMN "roomType";

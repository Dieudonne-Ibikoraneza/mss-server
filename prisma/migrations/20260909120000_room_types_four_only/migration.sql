/*
  Warnings:

  - The values [BALCONY,STAIRS,GATES,OUTDOOR] on the enum `RoomType` are being removed.
    The app now supports only LIVING_ROOM, BEDROOM, BATHROOM and KITCHEN. Rows still
    referencing a removed value are cleaned up first (no products use them; any seeded
    Balcony/Stairs/Gates rooms and their designs, and any room-scoped profiling
    questions for those rooms, are deleted).
*/

-- AlterEnum
BEGIN;

-- 1. Drop dependent data for the room types being removed.
DELETE FROM "RoomDesignTile"
WHERE "roomDesignId" IN (
  SELECT rd."id"
  FROM "RoomDesign" rd
  JOIN "Room" r ON r."id" = rd."roomId"
  WHERE r."type" IN ('BALCONY', 'STAIRS', 'GATES', 'OUTDOOR')
);

DELETE FROM "RoomDesign"
WHERE "roomId" IN (
  SELECT "id" FROM "Room" WHERE "type" IN ('BALCONY', 'STAIRS', 'GATES', 'OUTDOOR')
);

DELETE FROM "Room"
WHERE "type" IN ('BALCONY', 'STAIRS', 'GATES', 'OUTDOOR');

DELETE FROM "ProfilingQuestion"
WHERE "roomType" IN ('BALCONY', 'STAIRS', 'GATES', 'OUTDOOR');

-- Strip any removed values from Product.roomTypes arrays (expected to be a no-op).
UPDATE "Product"
SET "roomTypes" = (
  SELECT COALESCE(array_agg(rt), ARRAY[]::text[])
  FROM unnest("roomTypes"::text[]) AS rt
  WHERE rt NOT IN ('BALCONY', 'STAIRS', 'GATES', 'OUTDOOR')
)::"RoomType"[]
WHERE "roomTypes"::text[] && ARRAY['BALCONY', 'STAIRS', 'GATES', 'OUTDOOR'];

-- 2. Swap the enum for one with only the four supported values.
CREATE TYPE "RoomType_new" AS ENUM ('LIVING_ROOM', 'BEDROOM', 'BATHROOM', 'KITCHEN');

ALTER TABLE "Product"
  ALTER COLUMN "roomTypes" TYPE "RoomType_new"[]
  USING ("roomTypes"::text::"RoomType_new"[]);

ALTER TABLE "Room"
  ALTER COLUMN "type" TYPE "RoomType_new"
  USING ("type"::text::"RoomType_new");

ALTER TABLE "ProfilingQuestion"
  ALTER COLUMN "roomType" TYPE "RoomType_new"
  USING ("roomType"::text::"RoomType_new");

ALTER TYPE "RoomType" RENAME TO "RoomType_old";
ALTER TYPE "RoomType_new" RENAME TO "RoomType";
DROP TYPE "RoomType_old";

COMMIT;

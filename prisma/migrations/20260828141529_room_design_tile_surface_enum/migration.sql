-- Placement surface for a saved room design tile is always one physical
-- surface (unlike a product's own SuitableFor, which can be BOTH).
CREATE TYPE "RoomSurface" AS ENUM ('FLOOR', 'WALL');
ALTER TABLE "RoomDesignTile" ALTER COLUMN "surface" TYPE "RoomSurface" USING ("surface"::"RoomSurface");

CREATE TYPE "VisualizerTileCorner" AS ENUM ('TOP_RIGHT', 'BOTTOM_RIGHT', 'BOTTOM_LEFT', 'TOP_LEFT');
ALTER TABLE "Product" ADD COLUMN "visualizerPatternCorner" "VisualizerTileCorner" NOT NULL DEFAULT 'TOP_RIGHT';

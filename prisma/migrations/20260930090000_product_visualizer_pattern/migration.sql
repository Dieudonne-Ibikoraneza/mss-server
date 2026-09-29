CREATE TYPE "VisualizerTilePattern" AS ENUM ('STRAIGHT', 'QUARTER_TURN');

ALTER TABLE "Product"
ADD COLUMN "visualizerPattern" "VisualizerTilePattern";

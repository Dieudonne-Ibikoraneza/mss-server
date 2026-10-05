import type { SuitableFor, VisualizerTileCorner, VisualizerTilePattern } from '@prisma/client';

export interface TileRenderingSpec {
  name: string;
  description: string | null;
  size: string;
  tileAreaSqm?: number;
  suitableFor?: SuitableFor;
  visualizerPattern?: VisualizerTilePattern | null;
  visualizerPatternCorner?: VisualizerTileCorner;
}

const format = (value: number) => Number(value.toFixed(2)).toString();

/** Physical dimensions come from catalog data, never a photo crop or the model's guess. */
export function tileDimensionsMetres(size: string): [number, number] | null {
  const match = size.match(
    /(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*[x×✕]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\b/i,
  );
  if (!match) return null;
  const firstUnit = (match[2] ?? match[4]).toLowerCase();
  const secondUnit = match[4].toLowerCase();
  const factor = (unit: string) => (unit === 'mm' ? 0.001 : unit === 'cm' ? 0.01 : 1);
  const width = Number(match[1].replace(',', '.')) * factor(firstUnit);
  const height = Number(match[3].replace(',', '.')) * factor(secondUnit);
  return width > 0 && height > 0 && Number.isFinite(width * height) ? [width, height] : null;
}

export function effectiveTilePattern(product: TileRenderingSpec) {
  const dimensions = tileDimensionsMetres(product.size);
  const pattern = product.visualizerPattern ?? 'STRAIGHT';
  return pattern === 'QUARTER_TURN' && dimensions && Math.abs(dimensions[0] - dimensions[1]) > 1e-6
    ? 'TWO_TURN'
    : pattern;
}

export function tileInstallationInstructions(
  product: TileRenderingSpec,
  label: string,
  customerBrief = '',
): string {
  const dimensions = tileDimensionsMetres(product.size);
  const dimensionsArea = dimensions ? dimensions[0] * dimensions[1] : undefined;
  const area =
    dimensionsArea ??
    (product.tileAreaSqm && product.tileAreaSqm > 0 && Number.isFinite(product.tileAreaSqm)
      ? product.tileAreaSqm
      : undefined);
  // Match the 3D visualizer: quarter-turning a rectangle would distort its dimensions.
  const pattern = effectiveTilePattern(product);
  const layout =
    pattern === 'QUARTER_TURN'
      ? `FOUR-TURN: repeat a 2-by-2 group of FOUR separate tiles. Rotate whole tiles in 90-degree steps so the source photo's ${(product.visualizerPatternCorner ?? 'TOP_RIGHT').toLowerCase().replace('_', '-')} corner meets at the center of each group. Keep a grout boundary between all four tiles. The assembled motif is four tiles, never one enlarged tile.${dimensions ? ` Each group measures ${format(dimensions[0] * 2)} m by ${format(dimensions[1] * 2)} m.` : ''}`
      : pattern === 'TWO_TURN'
        ? 'TWO-TURN: alternate the original tile and a 180-degree-rotated copy in a checkerboard across rows and columns. Rotate the entire printed tile; do not rotate or redraw individual bands inside it. Do not use 90-degree turns.'
        : 'STRAIGHT: repeat the original complete tile in the same orientation in every cell; no random rotation or mirroring.';
  let scale = `Exact physical size of EACH ${label}: ${product.size}. This is catalog data, not an estimate. Never infer physical size from the reference photo's crop or aspect ratio.`;
  if (dimensions) {
    const [width, height] = dimensions;
    scale += ` Each tile is ${format(width)} m by ${format(height)} m. One metre spans approximately ${format(1 / width)} tile widths and ${format(1 / height)} tile heights; a 3 m span contains ${format(3 / width)} tile widths or ${format(3 / height)} tile heights. Use complete modules plus realistically cut edge tiles, not stretched modules.`;
    const roomSpans = [
      ...customerBrief.matchAll(/\b(\d+(?:\.\d+)?)\s*m\s*[x×]\s*(\d+(?:\.\d+)?)\s*m\b/gi),
    ];
    const room = roomSpans.at(-1);
    if (room && label === 'floor tile') {
      const length = Number(room[1]);
      const depth = Number(room[2]);
      if (length > 0 && depth > 0) {
        scale += ` The customer's ${format(length)} m by ${format(depth)} m room requires about ${format(length / width)} by ${format(depth / height)} tile modules (${Math.ceil((length * depth) / (width * height))} tile-area equivalents before waste). This is a scale check for the entire floor, not a requirement to expose every tile through furniture.`;
      }
    }
  }
  if (area)
    scale += ` Density: approximately ${format(1 / area)} individual tiles per square metre.`;

  return `${label.toUpperCase()} — REFERENCE ARTWORK AND INSTALLATION CONSTRAINTS:
${scale}
Treat the catalog tile face as one physical repeat module. Preserve its exact internal geometry, number and width of bands, diagonal angles, vein placement, colors, contrast, border details, and finish. Printed wood strips or marble bands INSIDE a small square tile are artwork, not separate long planks. Do not extend those bands through the room, invent a new parquet/herringbone/star design, simplify the motif, blend adjacent tiles into a continuous slab, mirror it, or stretch the photo across multiple modules. Isolate the tile face if its photo has surrounding background.
Installation layout: ${layout}
Repeat the complete module over the tiled surface at the specified real size. Show many correctly sized tiles, not a handful of oversized panels. Use a consistent physical grout grid with fine realistic joints (about 2–3 mm), visible in the foreground and naturally narrower in perspective. Printed lines inside the tile must not replace its physical grout boundaries. Keep module dimensions and pattern repetition consistent across the entire floor/wall; distance changes apparent size through perspective only. The foreground, midground and background must form ONE continuous perspective plane: all parallel grout lines converge toward the same appropriate vanishing points, and tile rows become progressively shallower into the distance. Never show an orthographic texture grid below a perspective room. Use cut modules at walls and around fixtures. Keep the original artwork recognizable in the foreground; lighting and perspective may change its appearance, but may not redesign it.`;
}

export const TILE_PATTERN_CHECK = `Before returning the image, check that every physical tile repeats the reference artwork, the saved rotation layout is followed, tile and grout counts agree with the real dimensions, and no small tile has become an oversized plank or slab. Prioritize accurate tile reproduction over an invented dramatic floor pattern.`;
export const TILE_SCENE_CHECK = `${TILE_PATTERN_CHECK} Use a normal interior photograph from a standing eye-level camera looking slightly downward, with enough unobstructed foreground floor to see several complete tile modules clearly; do not crop or hide nearly all tiling under rugs. Every visible part of the floor must have the same continuous camera perspective and room lighting. Return one photorealistic finished room image without text, labels, logos, swatches, or a collage.`;

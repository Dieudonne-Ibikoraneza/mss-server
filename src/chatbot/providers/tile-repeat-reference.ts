import sharp, { type OverlayOptions } from 'sharp';
import {
  effectiveTilePattern,
  tileDimensionsMetres,
  type TileRenderingSpec,
} from './tile-rendering-prompt';

type ImageReference = { mimeType: string; data: string };
export const REPEAT_GRID_SIZE = 8;

/** Deterministic material reference: the real photograph is repeated, never generated or redrawn. */
export async function createTileRepeatReference(
  reference: ImageReference,
  product: TileRenderingSpec,
): Promise<ImageReference | null> {
  try {
    return await renderTileRepeatReference(reference, product);
  } catch {
    // Keep the original reference usable if the optional proof cannot be decoded.
    return null;
  }
}

async function renderTileRepeatReference(
  reference: ImageReference,
  product: TileRenderingSpec,
): Promise<ImageReference | null> {
  const dimensions = tileDimensionsMetres(product.size);
  if (!dimensions) return null;
  const [width, height] = dimensions;
  const pixelsPerMetre = 128 / Math.max(width, height);
  const tileWidth = Math.max(8, Math.round(width * pixelsPerMetre));
  const tileHeight = Math.max(8, Math.round(height * pixelsPerMetre));
  const grout = Math.max(1, Math.round(0.0025 * pixelsPerMetre));
  const face = await sharp(Buffer.from(reference.data, 'base64'))
    .rotate()
    .resize(tileWidth, tileHeight, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const pattern = effectiveTilePattern(product);
  const rotations = await Promise.all(
    [0, 90, 180, 270].map((angle) => sharp(face).rotate(angle).png().toBuffer()),
  );
  // Clockwise artwork rotations. This is the 3D shader's UV sampling layout
  // converted from bottom-up UV coordinates to top-down image coordinates.
  const fourTurn = [
    [1, 2],
    [0, 3],
  ];
  const cornerOffset = { TOP_RIGHT: 0, BOTTOM_RIGHT: 1, BOTTOM_LEFT: 2, TOP_LEFT: 3 }[
    product.visualizerPatternCorner ?? 'TOP_RIGHT'
  ];
  const overlays: OverlayOptions[] = [];
  for (let row = 0; row < REPEAT_GRID_SIZE; row++) {
    for (let column = 0; column < REPEAT_GRID_SIZE; column++) {
      const turn =
        pattern === 'QUARTER_TURN'
          ? (fourTurn[row % 2][column % 2] - cornerOffset + 4) % 4
          : pattern === 'TWO_TURN'
            ? ((row + column) % 2) * 2
            : 0;
      overlays.push({
        input: rotations[turn],
        left: column * (tileWidth + grout),
        top: row * (tileHeight + grout),
      });
    }
  }
  const image = await sharp({
    create: {
      width: REPEAT_GRID_SIZE * tileWidth + (REPEAT_GRID_SIZE - 1) * grout,
      height: REPEAT_GRID_SIZE * tileHeight + (REPEAT_GRID_SIZE - 1) * grout,
      channels: 3,
      background: '#b8b4aa',
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();
  return { mimeType: 'image/png', data: image.toString('base64') };
}

export function repeatReferenceInstructions(product: TileRenderingSpec, attachment: string) {
  const dimensions = tileDimensionsMetres(product.size);
  return `${attachment} is a planar INSTALLATION PROOF made from the exact catalog photograph: ${REPEAT_GRID_SIZE} individual tiles across and ${REPEAT_GRID_SIZE} down, with the saved rotation layout and physical grout boundaries.${dimensions ? ` Its tiled span is about ${Number((dimensions[0] * REPEAT_GRID_SIZE).toFixed(2))} m by ${Number((dimensions[1] * REPEAT_GRID_SIZE).toFixed(2))} m, plus thin joints.` : ''} Use it ONLY as a material texture reference. Map its repeated artwork onto the actual room surface at that physical scale, using the room camera's perspective across the ENTIRE surface. Never paste any unwarped portion of this top-down reference into the output: no flat square grid in the foreground, horizontal split, inset, comparison panel, texture board, or transition between a room photo and a flat texture. The proof is NOT a new tile: never fit its entire grid into a single tile cell, enlarge a four-tile motif to room size, or invent a different arrangement. The original photograph remains the reference for one tile's colors and finish.`;
}

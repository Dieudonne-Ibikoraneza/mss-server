export type TilePackaging = {
  tileAreaSqm: number;
  boxCoverageSqm: number;
  piecesPerBox: number;
};

export type TileQuantity = TilePackaging & {
  requiredArea: number;
  completeBoxes: number;
  boxArea: number;
  remainingArea: number;
  remainingPieces: number;
  totalPieces: number;
  purchasedArea: number;
};

/**
 * Mirrors client/src/lib/tile-calculator.ts so the server-computed price
 * quote always matches what the client previewed before checkout.
 */
export const calculateTileQuantity = (
  requiredArea: number,
  packaging: TilePackaging,
): TileQuantity => {
  const area = Math.max(0, Number.isFinite(requiredArea) ? requiredArea : 0);
  const completeBoxes = Math.floor(area / packaging.boxCoverageSqm);
  const boxArea = completeBoxes * packaging.boxCoverageSqm;
  const remainingArea = Math.max(0, area - boxArea);
  const remainingPieces = Math.ceil(remainingArea / packaging.tileAreaSqm);

  return {
    ...packaging,
    requiredArea: area,
    completeBoxes,
    boxArea,
    remainingArea,
    remainingPieces,
    totalPieces: completeBoxes * packaging.piecesPerBox + remainingPieces,
    purchasedArea: boxArea + remainingPieces * packaging.tileAreaSqm,
  };
};

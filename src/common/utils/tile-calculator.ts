/**
 * Upper bound for a single cart/order line's area, in m². Well past any real
 * order (a football pitch is ~7,140 m²) but comfortably under the hard
 * ceiling `CartItem.areaSqm` / `OrderItem.requiredAreaSqm` impose in the
 * database (`Decimal(10, 4)` — anything >= 10^6 overflows the column and
 * Postgres throws a raw, unhandled "numeric field overflow" instead of a
 * clean validation error). Enforced via `@Max` on the DTOs that accept a
 * customer-typed area, not here — this constant just keeps them agreeing.
 */
export const MAX_ORDER_AREA_SQM = 100_000;

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
/** Clears the odd floating-point trailing digit (e.g. 9.6 + 0.4 = 10.000000000000002) that plain arithmetic on areas is prone to, without rounding away genuine precision like 4.8 or 1.5. */
const roundArea = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export const calculateTileQuantity = (
  requiredArea: number,
  packaging: TilePackaging,
): TileQuantity => {
  const area = Math.max(0, Number.isFinite(requiredArea) ? requiredArea : 0);
  const completeBoxes = Math.floor(area / packaging.boxCoverageSqm);
  const boxArea = roundArea(completeBoxes * packaging.boxCoverageSqm);
  const remainingArea = roundArea(Math.max(0, area - boxArea));
  const remainingPieces = Math.ceil(remainingArea / packaging.tileAreaSqm);

  return {
    ...packaging,
    requiredArea: area,
    completeBoxes,
    boxArea,
    remainingArea,
    remainingPieces,
    totalPieces: completeBoxes * packaging.piecesPerBox + remainingPieces,
    purchasedArea: roundArea(boxArea + remainingPieces * packaging.tileAreaSqm),
  };
};

/**
 * The inverse conversion, for stock already on hand rather than stock to buy:
 * floors instead of `calculateTileQuantity`'s ceiling, since you can't
 * physically hold a partial piece — a sliver of area smaller than one tile
 * just isn't a whole piece yet, not something to round up and count.
 */
export const piecesFromAreaSqm = (areaSqm: number, packaging: TilePackaging) => {
  const area = Math.max(0, Number.isFinite(areaSqm) ? areaSqm : 0);
  const totalPieces = Math.floor(area / packaging.tileAreaSqm);
  const completeBoxes = Math.floor(totalPieces / packaging.piecesPerBox);
  const remainingPieces = totalPieces - completeBoxes * packaging.piecesPerBox;
  return { totalPieces, completeBoxes, remainingPieces };
};

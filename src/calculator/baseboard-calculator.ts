import { badRequest } from '@/common/errors/app-error';

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const micrometres = (metres: number) => Math.round(metres * 1_000_000);

/** Reserve whole tiles for strips; floor installation offcuts are not assumed reusable. */
export function calculateBaseboard(input: {
  size: string;
  tileAreaSqm: number;
  perimeterM: number;
  openingsWidthM: number;
  heightCm: number;
  cutWidthMm: number;
  wastagePercent: number;
  unitPrice: number;
}) {
  if (input.openingsWidthM > input.perimeterM) {
    throw badRequest(
      'calculator.baseboardOpeningsTooWide',
      'Openings cannot exceed the room perimeter.',
    );
  }
  const dimensions = /^\s*(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*cm\s*$/i.exec(input.size);
  const sides = dimensions ? [Number(dimensions[1]) / 100, Number(dimensions[2]) / 100] : [];
  if (
    sides.length !== 2 ||
    sides.some((side) => !Number.isFinite(side) || micrometres(side) <= 0)
  ) {
    throw badRequest(
      'calculator.baseboardTileSizeRequired',
      'This tile needs a valid width and length to calculate baseboard cuts.',
    );
  }
  const lengthM = round(input.perimeterM - input.openingsWidthM);
  const requiredLengthM = round(lengthM * (1 + input.wastagePercent / 100));
  const height = micrometres(input.heightCm / 100);
  const kerf = micrometres(input.cutWidthMm / 1000);
  const candidates = sides
    .map((stripLengthM, index) => {
      const across = micrometres(sides[1 - index]);
      const stripsPerTile = Math.floor((across + kerf) / (height + kerf));
      const requiredStrips = Math.ceil(micrometres(requiredLengthM) / micrometres(stripLengthM));
      return {
        stripLengthM,
        stripsPerTile,
        requiredStrips,
        totalTiles: stripsPerTile > 0 ? Math.ceil(requiredStrips / stripsPerTile) : Infinity,
      };
    })
    .filter((candidate) => candidate.stripsPerTile > 0);
  if (!candidates.length) {
    throw badRequest(
      'calculator.baseboardHeightTooLarge',
      'The baseboard height is too large for this tile.',
    );
  }
  // Try both cutting directions: fewest purchased tiles, then fewest strips.
  const cut = candidates.sort(
    (a, b) => a.totalTiles - b.totalTiles || a.requiredStrips - b.requiredStrips,
  )[0];
  const purchasedAreaSqm = round(cut.totalTiles * input.tileAreaSqm);
  return {
    perimeterM: round(input.perimeterM),
    openingsWidthM: input.openingsWidthM,
    lengthM,
    requiredLengthM,
    heightCm: input.heightCm,
    cutWidthMm: input.cutWidthMm,
    wastagePercent: input.wastagePercent,
    ...cut,
    purchasedAreaSqm,
    estimatedCost: purchasedAreaSqm * input.unitPrice,
  };
}

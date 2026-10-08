import { calculateBaseboard } from './baseboard-calculator';

const input = {
  size: '30×30cm',
  tileAreaSqm: 0.09,
  perimeterM: 22,
  openingsWidthM: 1,
  heightCm: 10,
  cutWidthMm: 3,
  wastagePercent: 10,
  unitPrice: 5000,
};

describe('baseboards cut from tiles', () => {
  it('deducts doors, adds the length allowance, and buys whole cutting tiles', () => {
    expect(calculateBaseboard(input)).toMatchObject({
      lengthM: 21,
      requiredLengthM: 23.1,
      stripLengthM: 0.3,
      stripsPerTile: 2,
      requiredStrips: 77,
      totalTiles: 39,
      purchasedAreaSqm: 3.51,
      estimatedCost: 17550,
    });
  });

  it('accounts for the blade instead of assuming three 10 cm strips fit into a 30 cm tile', () => {
    expect(calculateBaseboard({ ...input, cutWidthMm: 0 }).stripsPerTile).toBe(3);
    expect(calculateBaseboard(input).stripsPerTile).toBe(2);
  });

  it('chooses the cutting direction that needs fewer tiles', () => {
    expect(
      calculateBaseboard({
        ...input,
        size: '25x40cm',
        tileAreaSqm: 0.1,
        perimeterM: 20,
        openingsWidthM: 0,
        wastagePercent: 0,
      }),
    ).toMatchObject({ stripLengthM: 0.4, stripsPerTile: 2, totalTiles: 25 });
  });

  it('keeps exact decimal strip lengths from creating an extra strip or tile', () => {
    expect(
      calculateBaseboard({
        ...input,
        perimeterM: 0.9,
        openingsWidthM: 0,
        wastagePercent: 0,
        cutWidthMm: 0,
      }),
    ).toMatchObject({ requiredStrips: 3, totalTiles: 1 });
  });

  it('needs no extra tiles when the entire perimeter is excluded', () => {
    expect(calculateBaseboard({ ...input, openingsWidthM: 22 })).toMatchObject({
      lengthM: 0,
      totalTiles: 0,
      purchasedAreaSqm: 0,
      estimatedCost: 0,
    });
  });

  it('rejects excluded sections longer than the room perimeter', () => {
    expect(() => calculateBaseboard({ ...input, openingsWidthM: 23 })).toThrow(
      'Openings cannot exceed',
    );
  });

  it('rejects a height that cannot be cut from either side of the tile', () => {
    expect(() => calculateBaseboard({ ...input, heightCm: 31 })).toThrow('height is too large');
  });

  it('does not guess physical dimensions from a descriptive collection size', () => {
    expect(() => calculateBaseboard({ ...input, size: 'Large tile' })).toThrow(
      'valid width and length',
    );
  });
});

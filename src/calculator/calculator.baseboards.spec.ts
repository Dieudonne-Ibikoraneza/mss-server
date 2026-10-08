import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CalculatorService } from './calculator.service';
import { FloorPlanDto } from './dto/floor-plan.dto';
import { calculateTileQuantity } from '@/common/utils/tile-calculator';

describe('floor and baseboard material estimates', () => {
  const product = {
    price: 5000,
    currency: 'RWF',
    quantityOnHandSqm: 120,
    reservedAreaSqm: 0,
    boxCoverageSqm: 1.44,
    piecesPerBox: 16,
    collection: { size: '30×30cm', tileAreaSqm: 0.09 },
  };
  const dto: FloorPlanDto = { productId: 'tile', length: 6, width: 5, wastagePercent: 10 };
  const findUnique = jest.fn();
  let service: CalculatorService;

  beforeEach(() => {
    findUnique.mockResolvedValue(product);
    service = new CalculatorService({ product: { findUnique } } as never);
  });

  it('preserves floor-only estimates when baseboards are off', async () => {
    const result = await service.calculate(dto);
    expect(result.baseboard).toBeNull();
    expect(result.requiredAreaSqm).toBe(33);
    expect(result.quantity).toEqual(result.floor.quantity);
    expect(result.estimatedCost).toBe(result.floor.estimatedCost);
  });

  it('uses the rectangular perimeter and pools floor and cutting tiles into one cart quantity', async () => {
    const result = await service.calculate({
      ...dto,
      baseboard: { heightCm: 10, openingsWidthM: 1 },
    });
    expect(result.baseboard).toMatchObject({ perimeterM: 22, totalTiles: 39 });
    expect(result.quantity.totalPieces).toBe(result.floor.quantity.totalPieces + 39);
    expect(result.requiredAreaSqm).toBe(36.54);
    expect(result.estimatedCost).toBe(182700);
    expect(result.estimatedCost).toBe(result.floor.estimatedCost + result.baseboard!.estimatedCost);
    expect(
      calculateTileQuantity(result.requiredAreaSqm, {
        tileAreaSqm: product.collection.tileAreaSqm,
        boxCoverageSqm: product.boxCoverageSqm,
        piecesPerBox: product.piecesPerBox,
      }).totalPieces,
    ).toBe(result.quantity.totalPieces);
  });

  it('cannot infer a perimeter from area alone, even when unused dimensions are also sent', async () => {
    await expect(
      service.calculate({ ...dto, totalAreaSqm: 30, baseboard: { heightCm: 10 } }),
    ).rejects.toThrow('Enter the room perimeter');
  });

  it('accepts an explicit perimeter for area-only and irregular rooms', async () => {
    const result = await service.calculate({
      ...dto,
      totalAreaSqm: 30,
      baseboard: { heightCm: 10, perimeterM: 28, openingsWidthM: 2 },
    });
    expect(result.baseboard).toMatchObject({ perimeterM: 28, lengthM: 26 });
  });

  it('applies a separate baseboard allowance without inflating the detail-page floor area', async () => {
    const result = await service.calculate({
      productId: 'tile',
      totalAreaSqm: 26,
      wastagePercent: 0,
      baseboard: { heightCm: 10, perimeterM: 22, openingsWidthM: 1, wastagePercent: 10 },
    });
    expect(result.floor.requiredAreaSqm).toBe(26);
    expect(result.floor.quantity.purchasedArea).toBe(26.01);
    expect(result.baseboard).toMatchObject({
      lengthM: 21,
      requiredLengthM: 23.1,
      wastagePercent: 10,
      totalTiles: 39,
    });
    expect(result.requiredAreaSqm).toBe(29.52);
    expect(result.quantity.totalPieces).toBe(328);
  });

  it('includes cutting tiles in availability without exposing exact stock counts', async () => {
    findUnique.mockResolvedValue({ ...product, quantityOnHandSqm: 34 });
    expect((await service.calculate(dto)).stockSplit.fullyAvailableFromStock).toBe(true);
    const result = await service.calculate({
      ...dto,
      baseboard: { heightCm: 10, openingsWidthM: 1 },
    });
    expect(result.stockSplit).toEqual({
      fullyAvailableFromStock: false,
      partiallyAvailableFromStock: true,
    });
  });

  it('preserves the tile count when declared box coverage differs from summed tile areas', async () => {
    findUnique.mockResolvedValue({ ...product, boxCoverageSqm: 1.45 });
    const result = await service.calculate({
      ...dto,
      baseboard: { heightCm: 10, perimeterM: 100 },
    });
    expect(result.quantity.totalPieces).toBe(
      result.floor.quantity.totalPieces + result.baseboard!.totalTiles,
    );
    expect(result.estimatedCost).toBeCloseTo(
      result.floor.estimatedCost + result.baseboard!.estimatedCost,
      6,
    );
  });

  it('keeps floor quantities and cost unchanged when openings leave no baseboard length', async () => {
    const floor = await service.calculate(dto);
    const result = await service.calculate({
      ...dto,
      baseboard: { heightCm: 10, openingsWidthM: 22 },
    });
    expect(result.baseboard?.totalTiles).toBe(0);
    expect(result.quantity).toEqual(floor.quantity);
    expect(result.baseboard?.estimatedCost).toBe(0);
  });

  it('checks availability against the area the combined cart will actually reserve', async () => {
    findUnique.mockResolvedValue({ ...product, boxCoverageSqm: 1.45, quantityOnHandSqm: 49.7 });
    const result = await service.calculate({
      ...dto,
      baseboard: { heightCm: 10, perimeterM: 100 },
    });
    expect(result.quantity.purchasedArea).toBeGreaterThan(49.7);
    expect(result.stockSplit.fullyAvailableFromStock).toBe(false);
    expect(result.baseboard!.purchasedAreaSqm * 5000).toBe(result.baseboard!.estimatedCost);
  });

  it.each([0.01, 1.08, 2.07, 3, 30])(
    'reserves enough floor and baseboard tiles for %s m²',
    async (area) => {
      const result = await service.calculate({
        ...dto,
        totalAreaSqm: area,
        wastagePercent: 0,
        baseboard: { heightCm: 10, perimeterM: 1.2 },
      });
      expect(result.quantity.totalPieces).toBe(
        result.floor.quantity.totalPieces + result.baseboard!.totalTiles,
      );
      expect(result.estimatedCost).toBeCloseTo(
        result.floor.estimatedCost + result.baseboard!.estimatedCost,
        6,
      );
    },
  );

  it.each([
    [],
    { heightCm: 0 },
    { heightCm: 10, cutWidthMm: -1 },
    { heightCm: 10, openingsWidthM: -1 },
  ])('validates nested baseboard inputs before calculating: %p', async (baseboard) => {
    const value = plainToInstance(FloorPlanDto, {
      ...dto,
      productId: '9d58a83a-a833-4b7d-a5d4-41f02151936a',
      baseboard,
    });
    expect(await validate(value)).not.toHaveLength(0);
  });
});

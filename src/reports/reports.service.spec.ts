import { ReportsService } from './reports.service';

describe('ReportsService — lowStock', () => {
  let prisma: {
    product: { findMany: jest.Mock };
    platformSetting: { findUnique: jest.Mock };
  };
  let storage: { resolveImageUrl: jest.Mock };
  let service: ReportsService;

  const product = (id: string, quantityOnHandSqm: number) => ({
    id,
    name: `Tile ${id}`,
    sku: `SKU-${id}`,
    image: `products/${id}.webp`,
    quantityOnHandSqm,
  });

  beforeEach(() => {
    prisma = {
      product: { findMany: jest.fn() },
      // Threshold of 100 sqm (cached in-process after the first read — same value every spec).
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: 100 }) },
    };
    storage = {
      resolveImageUrl: jest.fn((image: string) =>
        Promise.resolve(`https://signed.example/${image}?token=abc`),
      ),
    };
    service = new ReportsService(prisma as never, storage as never);
  });

  it('returns a loadable URL for each product image instead of the raw storage path', async () => {
    prisma.product.findMany.mockResolvedValue([product('a', 10)]);

    const rows = await service.lowStock();

    expect(rows).toHaveLength(1);
    expect(rows[0].image).toBe('https://signed.example/products/a.webp?token=abc');
    expect(storage.resolveImageUrl).toHaveBeenCalledWith('products/a.webp');
  });

  it('only resolves images for the rows it actually returns, worst stock first', async () => {
    prisma.product.findMany.mockResolvedValue([
      product('plenty', 5000),
      product('low', 40),
      product('out', 0),
    ]);

    const rows = await service.lowStock(1);

    expect(rows.map((row) => row.productId)).toEqual(['out']);
    expect(rows[0].stockStatus).toBe('out_of_stock');
    expect(storage.resolveImageUrl).toHaveBeenCalledTimes(1);
  });

  it('leaves products above the threshold out of the report', async () => {
    prisma.product.findMany.mockResolvedValue([product('plenty', 5000)]);

    await expect(service.lowStock()).resolves.toEqual([]);
    expect(storage.resolveImageUrl).not.toHaveBeenCalled();
  });
});

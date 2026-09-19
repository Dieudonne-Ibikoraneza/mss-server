import { InsufficientStockError, reserveAreaAtomically } from './stock-reservation.util';

describe('reserveAreaAtomically', () => {
  const txReturning = (rows: number) => {
    const executeRaw = jest.fn().mockResolvedValue(rows);
    return { tx: { $executeRaw: executeRaw } as never, executeRaw };
  };

  it('does nothing when the net change is zero', async () => {
    const { tx, executeRaw } = txReturning(0);
    await reserveAreaAtomically(tx, [
      { productId: 'a', deltaAreaSqm: 4 },
      { productId: 'a', deltaAreaSqm: -4 },
    ]);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('passes when every product row matched the availability condition', async () => {
    const { tx, executeRaw } = txReturning(2);
    await reserveAreaAtomically(tx, [
      { productId: 'a', deltaAreaSqm: 4 },
      { productId: 'b', deltaAreaSqm: 2 },
    ]);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('throws so the transaction rolls back when any product lacked the stock', async () => {
    const { tx } = txReturning(1);
    await expect(
      reserveAreaAtomically(tx, [
        { productId: 'a', deltaAreaSqm: 4 },
        { productId: 'b', deltaAreaSqm: 2 },
      ]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });
});

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AnalyticsPeriod, bucketize, resolvePeriod } from '@/common/utils/analytics-period';
import { QueryStockExportDto } from './dto/query-stock-export.dto';
import { resolveStockExportPeriod } from './stock-export-period';

const now = new Date('2026-10-09T12:00:00Z');
const query = (value: Partial<QueryStockExportDto>) =>
  Object.assign(new QueryStockExportDto(), value);

describe('custom stock export date windows', () => {
  it('retains the shared preset windows when custom dates are absent', () => {
    expect(resolveStockExportPeriod(query({ period: AnalyticsPeriod.WEEKLY }), now)).toEqual(
      resolvePeriod(AnalyticsPeriod.WEEKLY, now),
    );
  });

  it('includes the entire end date and excludes the next day', () => {
    const period = resolveStockExportPeriod(
      query({ startDate: '2026-10-05', endDate: '2026-10-05' }),
      now,
    );
    expect(period.from.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(
      bucketize(
        [
          new Date('2026-10-05T00:00:00Z'),
          new Date('2026-10-05T23:59:59.999Z'),
          new Date('2026-10-06T00:00:00Z'),
        ],
        period,
        (date) => date,
      ),
    ).toEqual([{ label: 'Oct 05', value: 2 }]);
  });

  it('buckets long ranges by month and clips partial first and last months', () => {
    const period = resolveStockExportPeriod(
      query({ startDate: '2025-11-15', endDate: '2026-03-06' }),
      now,
    );
    expect(period.buckets).toHaveLength(5);
    expect(period.buckets[0].start).toEqual(period.from);
    expect(period.buckets[4].end).toEqual(period.to);
    expect(period.buckets.map((row) => row.label)).toEqual([
      'Nov 2025',
      'Dec 2025',
      'Jan 2026',
      'Feb 2026',
      'Mar 2026',
    ]);
  });

  it.each([
    { startDate: '2026-10-05' },
    { endDate: '2026-10-05' },
    { startDate: '2026-10-06', endDate: '2026-10-05' },
    { startDate: '2026-02-30', endDate: '2026-03-05' },
    { startDate: '2026-10-05T12:00:00Z', endDate: '2026-10-06' },
  ])('rejects invalid or incomplete ranges: %j', (value) => {
    expect(() => resolveStockExportPeriod(query(value), now)).toThrow(BadRequestException);
  });

  it('validates date-only inputs at the endpoint and accepts leap days', async () => {
    expect(
      await validate(
        plainToInstance(QueryStockExportDto, { startDate: '2028-02-29', endDate: '2028-03-01' }),
      ),
    ).toEqual([]);
    expect(
      (await validate(plainToInstance(QueryStockExportDto, { startDate: '2026-02-30' }))).length,
    ).toBeGreaterThan(0);
    expect(
      (await validate(plainToInstance(QueryStockExportDto, { endDate: '2026-10-05T12:00:00Z' })))
        .length,
    ).toBeGreaterThan(0);
  });
});

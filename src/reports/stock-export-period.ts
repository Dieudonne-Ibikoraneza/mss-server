import { badRequest } from '@/common/errors/app-error';
import { resolvePeriod, type ResolvedPeriod } from '@/common/utils/analytics-period';
import { QueryStockExportDto } from './dto/query-stock-export.dto';

/** Custom dates include both selected UTC calendar days. Stock valuation remains current. */
export function resolveStockExportPeriod(query: QueryStockExportDto, now: Date): ResolvedPeriod {
  if (query.startDate === undefined && query.endDate === undefined)
    return resolvePeriod(query.period, now);
  const parse = (value?: string) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      ? date
      : null;
  };
  const from = parse(query.startDate);
  const end = parse(query.endDate);
  if (!from || !end || from > end)
    throw badRequest(
      'reports.invalidDateRange',
      'Choose a valid start and end date. The end date must not be before the start date.',
    );
  const to = new Date(end);
  to.setUTCDate(to.getUTCDate() + 1);
  const daily = (to.getTime() - from.getTime()) / 86400000 <= 90;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(daily ? { month: 'short', day: '2-digit' } : { month: 'short', year: 'numeric' }),
  });
  const buckets: ResolvedPeriod['buckets'] = [];
  let cursor = new Date(from);
  if (!daily) cursor.setUTCDate(1);
  while (cursor < to) {
    const next = new Date(cursor);
    if (daily) next.setUTCDate(next.getUTCDate() + 1);
    else next.setUTCMonth(next.getUTCMonth() + 1);
    buckets.push({
      label: format.format(cursor),
      start: new Date(Math.max(cursor.getTime(), from.getTime())),
      end: new Date(Math.min(next.getTime(), to.getTime())),
    });
    cursor = next;
  }
  return { period: query.period ?? resolvePeriod(undefined, now).period, from, to, buckets };
}

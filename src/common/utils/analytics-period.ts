/**
 * The three reporting windows every dashboard and report in the app offers
 * (the "7 DAYS / 30 DAYS / 12 MONTHS" switcher). Resolving a period yields both
 * the overall range to filter on and the buckets to plot a trend over, so every
 * endpoint labels and slices time the same way.
 */
export enum AnalyticsPeriod {
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

export interface PeriodBucket {
  /** Human label for the x-axis, e.g. "Mon", "Oct 05", "Jan". */
  label: string;
  start: Date;
  /** Exclusive upper bound. */
  end: Date;
}

export interface ResolvedPeriod {
  period: AnalyticsPeriod;
  from: Date;
  to: Date;
  buckets: PeriodBucket[];
}

const DAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const DATE_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});
const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

const startOfUtcDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const startOfUtcMonth = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

/**
 * Turns a period into a concrete range plus its buckets, ending at the current
 * day/month inclusive. WEEKLY and MONTHLY bucket by day (7 and 30 of them),
 * YEARLY buckets by calendar month (12 of them).
 */
export const resolvePeriod = (
  period: AnalyticsPeriod = AnalyticsPeriod.MONTHLY,
  now: Date = new Date(),
): ResolvedPeriod => {
  if (period === AnalyticsPeriod.YEARLY) {
    const firstBucket = addMonths(startOfUtcMonth(now), -11);
    const buckets = Array.from({ length: 12 }, (_, index) => {
      const start = addMonths(firstBucket, index);
      return { label: MONTH_LABEL.format(start), start, end: addMonths(start, 1) };
    });
    return { period, from: firstBucket, to: buckets[buckets.length - 1].end, buckets };
  }

  const days = period === AnalyticsPeriod.WEEKLY ? 7 : 30;
  const firstBucket = addDays(startOfUtcDay(now), -(days - 1));
  const format = period === AnalyticsPeriod.WEEKLY ? DAY_LABEL : DATE_LABEL;
  const buckets = Array.from({ length: days }, (_, index) => {
    const start = addDays(firstBucket, index);
    return { label: format.format(start), start, end: addDays(start, 1) };
  });

  return { period, from: firstBucket, to: buckets[buckets.length - 1].end, buckets };
};

/**
 * Drops timestamped rows into the resolved period's buckets and sums a value
 * from each. Rows outside the range are ignored, so callers can pass a wider
 * result set without pre-filtering.
 */
export const bucketize = <T>(
  rows: T[],
  resolved: ResolvedPeriod,
  at: (row: T) => Date,
  value: (row: T) => number = () => 1,
) => {
  const totals = new Array<number>(resolved.buckets.length).fill(0);

  for (const row of rows) {
    const time = at(row).getTime();
    if (time < resolved.from.getTime() || time >= resolved.to.getTime()) continue;
    const index = resolved.buckets.findIndex(
      (bucket) => time >= bucket.start.getTime() && time < bucket.end.getTime(),
    );
    if (index >= 0) totals[index] += value(row);
  }

  return resolved.buckets.map((bucket, index) => ({ label: bucket.label, value: totals[index] }));
};

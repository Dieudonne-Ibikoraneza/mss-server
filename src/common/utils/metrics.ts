/**
 * The percentage formulas every dashboard/report computes (doc 3.9's
 * "FORMULAS" panel), kept in one place so every service uses the exact same
 * math rather than re-deriving it slightly differently per screen:
 *
 *   Tile Selection Rate        = applied / viewed * 100
 *   Tile Purchase Conversion   = purchased / viewed * 100
 *   Recommendation Acceptance  = accepted / displayed * 100
 *   Recommendation Purchase    = purchased / displayed * 100
 *
 * All four (and every other rate in the app — repeat purchase rate, funnel
 * drop-off, etc.) reduce to the same shape: `percent(part, whole)`. Callers
 * just supply the right numerator/denominator for their formula.
 */
export const percent = (part: number, whole: number): number => (whole ? (part / whole) * 100 : 0);

/**
 * Percent change between two periods of the same length, e.g. "+12.4% vs
 * last period". `previous === 0` is defined as +100% if something now exists
 * where nothing did, 0% if both are still zero — there's no meaningful ratio
 * otherwise.
 */
export const percentChange = (current: number, previous: number): number => {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
};

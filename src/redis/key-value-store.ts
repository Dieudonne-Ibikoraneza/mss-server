/**
 * The small set of atomic operations the app needs for its short-lived state (OTP codes and
 * attempt counters, pending registrations, duplicate-suppression keys). Redis implements it
 * natively; Postgres implements it with one table (`KeyValueEntry`) for deployments with no Redis.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, payload: string, ttlSeconds?: number): Promise<void>;
  /** Claims `key` only if it is absent (or expired); true means this caller got it. */
  setIfAbsent(key: string, payload: string, ttlSeconds: number): Promise<boolean>;
  /** Number of live keys removed (0 or 1) — what decides who consumes a one-time code. */
  del(key: string): Promise<number>;
  /** Atomic increment; `ttlSeconds` is applied when the counter is (re)created, like `INCR` + `EXPIRE`. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /** Seconds left, `-1` if the key never expires, `-2` if it does not exist. */
  ttl(key: string): Promise<number>;
}

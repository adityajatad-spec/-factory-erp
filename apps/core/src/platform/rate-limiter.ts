/**
 * An in-process sliding-window rate limiter: at most `limit` admissions per key in any
 * `windowMs`. Times come from a monotonic clock (`performance.now()` by default), so a
 * wall-clock change neither unlocks nor blocks anyone.
 *
 * PER PROCESS: each server process counts on its own and the counts are lost on restart. It is
 * not a distributed rate limiter; with several processes the effective limit multiplies.
 *
 * Memory is bounded: at most `maxKeys` keys of at most `limit` timestamps each. Past `maxKeys`,
 * keys with no admission inside the window are dropped first, then the least recently admitted
 * key (whose window then starts afresh — a deliberate trade for a hard memory bound; keys are
 * only ever created for authenticated users, so the bound is not reachable from outside).
 */
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
}

export type RateLimitDecision =
  | { ok: true; /** Give the admission back (the work it admitted never ran). */ release(): void }
  | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  take(key: string): RateLimitDecision;
  /** Keys currently held (for tests and diagnostics). */
  size(): number;
}

export const DEFAULT_RATE_LIMITER_MAX_KEYS = 1000;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = opts;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('rate limit must be a positive integer');
  if (!(windowMs > 0)) throw new Error('rate limit window must be positive');
  const maxKeys = opts.maxKeys ?? DEFAULT_RATE_LIMITER_MAX_KEYS;
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new Error('maxKeys must be a positive integer');
  const now = opts.now ?? (() => performance.now());
  // Insertion order is recency order: a key is re-inserted on every admission.
  const keys = new Map<string, number[]>();

  const live = (stamps: number[], t: number) => {
    while (stamps.length > 0 && (stamps[0] ?? 0) <= t - windowMs) stamps.shift();
    return stamps;
  };

  const evict = (t: number) => {
    for (const [k, stamps] of keys) if (live(stamps, t).length === 0) keys.delete(k);
    while (keys.size > maxKeys) {
      const oldest = keys.keys().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
    }
  };

  return {
    limit,
    windowMs,
    take(key) {
      const t = now();
      const stamps = live(keys.get(key) ?? [], t);
      if (stamps.length >= limit) {
        const retryAfterMs = Math.max(1, Math.ceil((stamps[0] ?? t) + windowMs - t));
        return { ok: false, retryAfterMs };
      }
      stamps.push(t);
      keys.delete(key);
      keys.set(key, stamps);
      if (keys.size > maxKeys) evict(t);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          const held = keys.get(key);
          const i = held?.lastIndexOf(t) ?? -1;
          if (held && i >= 0) held.splice(i, 1);
        },
      };
    },
    size: () => keys.size,
  };
}

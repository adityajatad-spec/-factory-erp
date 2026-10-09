import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limiter';

/** A test monotonic clock. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('rate limiter', () => {
  it('admits `limit` per sliding window, then refuses with the time until the oldest expires', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    expect(rl.take('a').ok).toBe(true);
    c.advance(10_000);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a')).toEqual({ ok: false, retryAfterMs: 50_000 });
    c.advance(49_999);
    expect(rl.take('a').ok).toBe(false);
    c.advance(1);
    expect(rl.take('a').ok).toBe(true); // the first admission left the window
    expect(rl.take('a')).toEqual({ ok: false, retryAfterMs: 10_000 });
  });

  it('a refused attempt does not extend the wait', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    rl.take('a');
    for (let i = 0; i < 10; i++) {
      c.advance(50);
      expect(rl.take('a').ok).toBe(false);
    }
    c.advance(500);
    expect(rl.take('a').ok).toBe(true);
  });

  it('keys are independent', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    expect(rl.take('company-1:user-1').ok).toBe(true);
    expect(rl.take('company-1:user-1').ok).toBe(false);
    expect(rl.take('company-1:user-2').ok).toBe(true);
    expect(rl.take('company-2:user-1').ok).toBe(true);
  });

  it('release gives an admission back, once', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    const first = rl.take('a');
    if (!first.ok) throw new Error('admitted');
    first.release();
    first.release();
    const second = rl.take('a');
    expect(second.ok).toBe(true);
    expect(rl.take('a').ok).toBe(false);
  });

  it('storage is bounded: expired keys go first, then the least recently admitted', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 2, windowMs: 1_000, maxKeys: 3, now: c.now });
    rl.take('old-1');
    rl.take('old-2');
    c.advance(2_000); // both expired
    rl.take('k1');
    expect(rl.size()).toBe(3);
    rl.take('k2'); // over the bound: both expired keys are dropped, no live one
    expect(rl.size()).toBe(2);
    rl.take('k3');
    expect(rl.size()).toBe(3);
    rl.take('k1'); // k1 is now the most recent
    rl.take('k4'); // all live: the least recently admitted (k2) is dropped
    expect(rl.size()).toBe(3);
    expect(rl.take('k1')).toMatchObject({ ok: false }); // k1 kept its count
    expect(rl.take('k2').ok).toBe(true); // k2 started afresh
    for (let i = 0; i < 10_000; i++) rl.take(`flood-${i}`);
    expect(rl.size()).toBe(3);
  });

  it('uses the monotonic clock by default and rejects nonsensical settings', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a')).toMatchObject({ ok: false });
    expect(() => createRateLimiter({ limit: 0, windowMs: 1 })).toThrow();
    expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
    expect(() => createRateLimiter({ limit: 1, windowMs: 1, maxKeys: 0 })).toThrow();
  });
});

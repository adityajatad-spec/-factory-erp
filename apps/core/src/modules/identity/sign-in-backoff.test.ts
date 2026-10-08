import { describe, expect, it } from 'vitest';
import { FREE_FAILURES, signInDelayMs } from './sign-in-backoff';

const now = new Date('2026-10-05T10:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const fails = (n: number, everySeconds = 1) =>
  Array.from({ length: n }, (_, i) => ({
    outcome: 'BAD_CREDENTIALS',
    attemptedAt: ago(i * everySeconds),
  }));

describe('sign-in backoff', () => {
  it(`allows ${FREE_FAILURES} free failures`, () => {
    expect(signInDelayMs(fails(FREE_FAILURES - 1), now)).toBe(0);
    expect(signInDelayMs(fails(FREE_FAILURES), now)).toBe(30_000);
  });

  it('doubles per further failure up to 15 minutes', () => {
    expect(signInDelayMs(fails(6), now)).toBe(60_000);
    expect(signInDelayMs(fails(7), now)).toBe(120_000);
    expect(signInDelayMs(fails(30), now)).toBe(15 * 60_000);
  });

  it('counts down from the last failure', () => {
    const recent = fails(5).map((a) => ({
      ...a,
      attemptedAt: new Date(a.attemptedAt.getTime() - 20_000),
    }));
    expect(signInDelayMs(recent, now)).toBe(10_000);
  });

  it('a success resets the count; refused attempts do not extend the wait; old failures expire', () => {
    expect(
      signInDelayMs([...fails(3), { outcome: 'SUCCESS', attemptedAt: ago(10) }, ...fails(9)], now),
    ).toBe(0);
    expect(signInDelayMs([{ outcome: 'LOCKED_OUT', attemptedAt: ago(0) }, ...fails(5)], now)).toBe(
      30_000,
    );
    const yesterday = fails(10).map((a) => ({
      ...a,
      attemptedAt: new Date(a.attemptedAt.getTime() - 25 * 60 * 60_000),
    }));
    expect(signInDelayMs(yesterday, now)).toBe(0);
  });
});

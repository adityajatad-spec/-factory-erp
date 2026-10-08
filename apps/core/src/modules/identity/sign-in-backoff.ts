/**
 * Per-username sign-in backoff (Slice 0). It counts failed attempts since the last success
 * (within a day) and, after a few free tries, makes the next attempt wait — doubling up to a
 * cap. It is keyed on the username as typed, existing or not, so it reveals nothing about which
 * usernames are real; and it is a delay, not a permanent lock, so nobody can lock an employee
 * out for good by guessing at their username.
 */
export const FREE_FAILURES = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;
export const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;

export type AttemptOutcome = 'SUCCESS' | 'BAD_CREDENTIALS' | 'DISABLED' | 'LOCKED_OUT';

/** How long the next attempt must wait. `recent` is newest first. */
export function signInDelayMs(
  recent: readonly { outcome: string; attemptedAt: Date }[],
  now: Date,
): number {
  let failures = 0;
  let lastFailure: Date | undefined;
  for (const a of recent) {
    if (now.getTime() - a.attemptedAt.getTime() > ATTEMPT_WINDOW_MS) break;
    if (a.outcome === 'SUCCESS') break;
    // Attempts refused during a wait do not extend it.
    if (a.outcome === 'LOCKED_OUT') continue;
    failures++;
    lastFailure ??= a.attemptedAt;
  }
  if (failures < FREE_FAILURES || !lastFailure) return 0;
  const delay = Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_FAILURES), MAX_DELAY_MS);
  return Math.max(0, lastFailure.getTime() + delay - now.getTime());
}

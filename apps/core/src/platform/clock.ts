/** Injectable clock so time-dependent rules are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const d = typeof at === 'string' ? new Date(at) : at;
  return { now: () => new Date(d.getTime()) };
}

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

const ISO_DATE_IN_IST = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Business date (YYYY-MM-DD) in IST. Never derive business dates from UTC. */
export function businessDate(instant: Date): string {
  return ISO_DATE_IN_IST.format(instant);
}

/** Add whole days to an ISO date string without timezone drift. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (both YYYY-MM-DD); negative if `toIso` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

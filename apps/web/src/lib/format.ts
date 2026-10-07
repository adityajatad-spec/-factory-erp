import {
  formatIndianNumber,
  formatINR,
  isDecimalString,
  Money,
  parseDecimal,
} from '@factory-erp/money';

/** ₹ amount with Indian grouping. Inputs are exact decimal strings from the API. */
export function inr(amount: string | null | undefined): string {
  if (!amount || !isDecimalString(amount)) return '—';
  return formatINR(Money.round(parseDecimal(amount), 'HALF_UP'));
}

export function num(value: string | null | undefined, fractionDigits = 2): string {
  if (!value || !isDecimalString(value)) return '—';
  return formatIndianNumber(value, fractionDigits);
}

/** "10.000" → "10", "2.500" → "2.5" */
export function qty(value: string | null | undefined): string {
  if (!value) return '—';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** Business date (YYYY-MM-DD) → "05 Oct 2026". Parsed as UTC so it never shifts a day. */
export function date(iso: string | null | undefined): string {
  return iso ? DATE.format(new Date(`${iso}T00:00:00Z`)) : '—';
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? DATE_TIME.format(new Date(iso)) : '—';
}

/** Today's business date in IST, YYYY-MM-DD. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

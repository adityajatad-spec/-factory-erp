import { parseDecimal } from './decimal';
import type { Money } from './values';

/**
 * Format a decimal string with Indian digit grouping (lakh/crore): 1234567.8 → "12,34,567.80".
 * Pure string manipulation — no conversion through JS numbers.
 */
export function formatIndianNumber(value: string, fractionDigits = 2): string {
  const d = parseDecimal(value, 'formatIndianNumber');
  const fixed = d.abs().toFixed(fractionDigits);
  const [intPart = '0', fracPart] = fixed.split('.');

  let grouped: string;
  if (intPart.length <= 3) {
    grouped = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    const restGroups: string[] = [];
    for (let i = rest.length; i > 0; i -= 2) {
      restGroups.unshift(rest.slice(Math.max(0, i - 2), i));
    }
    grouped = `${restGroups.join(',')},${last3}`;
  }

  const sign = d.isNegative() && !d.isZero() ? '-' : '';
  return fracPart === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fracPart}`;
}

/** "₹12,34,567.80" */
export function formatINR(money: Money): string {
  const s = formatIndianNumber(money.toString(), 2);
  return s.startsWith('-') ? `-₹${s.slice(1)}` : `₹${s}`;
}

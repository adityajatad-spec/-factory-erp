import { describe, expect, it } from 'vitest';
import { date, inr, num, qty } from './format';

describe('format helpers', () => {
  it('trims only fractional trailing zeros', () => {
    expect(qty('10.000')).toBe('10');
    expect(qty('2.500')).toBe('2.5');
    expect(qty('100')).toBe('100');
    expect(qty('1200.0000')).toBe('1200');
  });

  it('formats rupees with Indian grouping', () => {
    expect(inr('116449.00')).toBe('₹1,16,449.00');
    expect(inr(null)).toBe('—');
    expect(num('1234567.891', 3)).toBe('12,34,567.891');
  });

  it('never shifts business dates across time zones', () => {
    expect(date('2026-04-01')).toBe('01 Apr 2026');
  });
});

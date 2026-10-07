import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatIndianNumber, formatINR } from './format';
import { Money } from './values';

describe('formatIndianNumber', () => {
  it.each([
    ['0', '0.00'],
    ['999', '999.00'],
    ['1000', '1,000.00'],
    ['100000', '1,00,000.00'],
    ['1234567.8', '12,34,567.80'],
    ['123456789012.34', '1,23,45,67,89,012.34'],
    ['-1234567.89', '-12,34,567.89'],
  ])('%s → %s', (input, expected) => {
    expect(formatIndianNumber(input)).toBe(expected);
  });

  it('matches Intl en-IN grouping for arbitrary values (property)', () => {
    const intl = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 99 }),
        (rupees, paise) => {
          const value = `${rupees}.${String(paise).padStart(2, '0')}`;
          // Intl accepts decimal strings exactly (no float conversion) in modern V8.
          expect(formatIndianNumber(value)).toBe(intl.format(value as unknown as number));
        },
      ),
    );
  });
});

describe('formatINR', () => {
  it('prefixes the rupee sign', () => {
    expect(formatINR(Money.of('1234567.5'))).toBe('₹12,34,567.50');
    expect(formatINR(Money.of('-10'))).toBe('-₹10.00');
  });
});

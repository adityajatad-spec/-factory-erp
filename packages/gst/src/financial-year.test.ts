import { describe, expect, it } from 'vitest';
import { financialYearOf } from './financial-year';

describe('financialYearOf', () => {
  it.each([
    ['2026-04-01', '2026-27', '26-27'],
    ['2027-03-31', '2026-27', '26-27'],
    ['2026-03-31', '2025-26', '25-26'],
    ['2099-12-31', '2099-00', '99-00'],
  ])('%s is in FY %s', (date, label, short) => {
    const fy = financialYearOf(date);
    expect(fy.label).toBe(label);
    expect(fy.short).toBe(short);
  });

  it('returns the boundary dates', () => {
    expect(financialYearOf('2026-10-05')).toEqual({
      label: '2026-27',
      short: '26-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });
  });

  it('rejects non-ISO input', () => {
    expect(() => financialYearOf('05/10/2026')).toThrow(RangeError);
    expect(() => financialYearOf('2026-13-01')).toThrow(RangeError);
  });
});

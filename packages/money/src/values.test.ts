import { describe, expect, it } from 'vitest';
import { Dec, DecimalFormatError } from './decimal';
import { Money, Percent, Qty, Rate } from './values';

describe('Money', () => {
  it('parses exact decimal strings and prints a fixed 2-decimal string', () => {
    expect(Money.of('10').toString()).toBe('10.00');
    expect(Money.of('1234.5').toString()).toBe('1234.50');
    expect(Money.of('-0.01').toString()).toBe('-0.01');
  });

  it('rejects JS numbers, exponents, grouping and over-precise values', () => {
    expect(() => Money.of(10 as unknown as string)).toThrow(DecimalFormatError);
    expect(() => Money.of('1e3')).toThrow(DecimalFormatError);
    expect(() => Money.of('1,000.00')).toThrow(DecimalFormatError);
    expect(() => Money.of('10.005')).toThrow(DecimalFormatError);
    expect(() => Money.of('')).toThrow(DecimalFormatError);
  });

  it('adds without floating point error (0.1 + 0.2 = 0.30)', () => {
    expect(Money.of('0.1').plus(Money.of('0.2')).toString()).toBe('0.30');
  });

  it('rounds only through an explicit mode', () => {
    expect(Money.round(new Dec('2.345'), 'HALF_UP').toString()).toBe('2.35');
    expect(Money.round(new Dec('2.345'), 'HALF_EVEN').toString()).toBe('2.34');
    expect(Money.round(new Dec('-2.345'), 'HALF_UP').toString()).toBe('-2.35');
    expect(Money.round(new Dec('2.349'), 'DOWN').toString()).toBe('2.34');
  });

  it('rounds to whole rupees', () => {
    expect(Money.of('100.49').roundToRupee('HALF_UP').toString()).toBe('100.00');
    expect(Money.of('100.50').roundToRupee('HALF_UP').toString()).toBe('101.00');
  });

  it('sums, compares and serialises to JSON strings', () => {
    const total = Money.sum([Money.of('1.10'), Money.of('2.20'), Money.of('3.30')]);
    expect(total.toString()).toBe('6.60');
    expect(total.compare(Money.of('6.6'))).toBe(0);
    expect(JSON.stringify({ total })).toBe('{"total":"6.60"}');
  });
});

describe('Qty / Rate / Percent', () => {
  it('enforce their scales', () => {
    expect(Qty.of('12.125').toString()).toBe('12.125');
    expect(() => Qty.of('1.0001')).toThrow(DecimalFormatError);
    expect(Rate.of('84.1234').toString()).toBe('84.1234');
    expect(() => Rate.of('1.00001')).toThrow(DecimalFormatError);
  });

  it('bounds percentages to 0..100', () => {
    expect(Percent.of('18').toString()).toBe('18');
    expect(Percent.of('2.5').half().toString()).toBe('1.25');
    expect(() => Percent.of('-1')).toThrow(DecimalFormatError);
    expect(() => Percent.of('100.001')).toThrow(DecimalFormatError);
  });

  it('applies a percentage exactly', () => {
    expect(Percent.of('18').applyTo(new Dec('1000.55')).toString()).toBe('180.099');
  });
});

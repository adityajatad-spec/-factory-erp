import { Dec, Money } from '@factory-erp/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateInvoice } from './engine';
import { DEFAULT_GST_POLICY, type InvoiceCalcInput } from './types';

const decimalString = (maxInt: number, scale: number, min = 0) =>
  fc
    .tuple(fc.integer({ min, max: maxInt }), fc.integer({ min: 0, max: 10 ** scale - 1 }))
    .map(([i, f]) => (scale === 0 ? String(i) : `${i}.${String(f).padStart(scale, '0')}`));

const lineArb = fc.record({
  quantity: decimalString(10_000, 3, 1),
  unitRate: decimalString(1_000_000, 4),
  discountPercent: fc.constantFrom('0', '2.5', '5', '10', '12.5', '100'),
  gstRatePercent: fc.constantFrom('0', '0.25', '3', '5', '12', '18', '28', '40'),
});

const inputArb: fc.Arbitrary<InvoiceCalcInput> = fc
  .record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 25 }),
    sameState: fc.boolean(),
    rounding: fc.constantFrom('NEAREST_RUPEE' as const, 'NONE' as const),
  })
  .map(({ lines, sameState, rounding }) => ({
    supplierStateCode: '27',
    placeOfSupplyStateCode: sameState ? '27' : '24',
    lines: lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    policy: { ...DEFAULT_GST_POLICY, invoiceRounding: rounding },
  }));

const m = (s: string) => Money.of(s);

describe('GST engine invariants (property-based)', () => {
  it('holds for arbitrary invoices', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = calculateInvoice(input);
        const t = r.totals;

        // Totals equal the sum of their lines.
        const sumOf = (pick: (l: (typeof r.lines)[number]) => string) =>
          Money.sum(r.lines.map((l) => m(pick(l))));
        expect(sumOf((l) => l.taxableAmount).equals(m(t.taxableAmount))).toBe(true);
        expect(sumOf((l) => l.cgstAmount).equals(m(t.cgstAmount))).toBe(true);
        expect(sumOf((l) => l.igstAmount).equals(m(t.igstAmount))).toBe(true);

        for (const l of r.lines) {
          // taxable = gross − discount, never negative
          expect(m(l.grossAmount).minus(m(l.discountAmount)).equals(m(l.taxableAmount))).toBe(true);
          expect(m(l.taxableAmount).isNegative()).toBe(false);
          // CGST always equals SGST; supply type decides which taxes exist
          expect(l.cgstAmount).toBe(l.sgstAmount);
          if (r.supplyType === 'INTRA_STATE') expect(l.igstAmount).toBe('0.00');
          else expect(l.cgstAmount).toBe('0.00');
        }

        // grand total = total before rounding + round-off
        expect(m(t.totalBeforeRounding).plus(m(t.roundOff)).equals(m(t.grandTotal))).toBe(true);
        expect(m(t.taxableAmount).plus(m(t.totalTax)).equals(m(t.totalBeforeRounding))).toBe(true);
        expect(new Dec(t.roundOff).abs().lessThanOrEqualTo('0.50')).toBe(true);
        if (input.policy.invoiceRounding === 'NEAREST_RUPEE') {
          expect(t.grandTotal.endsWith('.00')).toBe(true);
        } else {
          expect(t.roundOff).toBe('0.00');
        }

        // The rate summary reconciles to the totals.
        expect(Money.sum(r.taxSummary.map((s) => m(s.totalTax))).equals(m(t.totalTax))).toBe(true);
        expect(
          Money.sum(r.taxSummary.map((s) => m(s.taxableAmount))).equals(m(t.taxableAmount)),
        ).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const copy = JSON.parse(JSON.stringify(input)) as InvoiceCalcInput;
        expect(calculateInvoice(input)).toEqual(calculateInvoice(copy));
      }),
      { numRuns: 100 },
    );
  });
});

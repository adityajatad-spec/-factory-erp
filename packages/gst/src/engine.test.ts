import { describe, expect, it } from 'vitest';
import { calculateInvoice, GST_ENGINE_VERSION } from './engine';
import { GstCalculationError } from './errors';
import { DEFAULT_GST_POLICY, type InvoiceCalcInput, type LineInput } from './types';

/**
 * Hand-worked examples. These are ENGINEERING golden cases, not CA-signed cases — see
 * docs/ARCHITECTURE.md Round 2 §7 for the validation pipeline that must sign them off.
 */

const line = (overrides: Partial<LineInput> & Pick<LineInput, 'lineNo'>): LineInput => ({
  quantity: '1',
  unitRate: '100',
  discountPercent: '0',
  gstRatePercent: '18',
  ...overrides,
});

const intra = (lines: LineInput[]): InvoiceCalcInput => ({
  supplierStateCode: '27',
  placeOfSupplyStateCode: '27',
  lines,
  policy: DEFAULT_GST_POLICY,
});

describe('calculateInvoice — intra-state (CGST + SGST)', () => {
  const result = calculateInvoice(
    intra([
      line({ lineNo: 1, quantity: '10', unitRate: '125.50', gstRatePercent: '18' }),
      line({
        lineNo: 2,
        quantity: '2.5',
        unitRate: '340',
        discountPercent: '10',
        gstRatePercent: '12',
      }),
    ]),
  );

  it('computes each line', () => {
    expect(result.supplyType).toBe('INTRA_STATE');
    expect(result.lines[0]).toMatchObject({
      grossAmount: '1255.00',
      discountAmount: '0.00',
      taxableAmount: '1255.00',
      cgstRatePercent: '9',
      cgstAmount: '112.95',
      sgstRatePercent: '9',
      sgstAmount: '112.95',
      igstAmount: '0.00',
      lineTotal: '1480.90',
    });
    expect(result.lines[1]).toMatchObject({
      grossAmount: '850.00',
      discountAmount: '85.00',
      taxableAmount: '765.00',
      cgstAmount: '45.90',
      sgstAmount: '45.90',
      lineTotal: '856.80',
    });
  });

  it('computes totals, round-off and words', () => {
    expect(result.totals).toEqual({
      grossAmount: '2105.00',
      discountAmount: '85.00',
      taxableAmount: '2020.00',
      cgstAmount: '158.85',
      sgstAmount: '158.85',
      igstAmount: '0.00',
      totalTax: '317.70',
      totalBeforeRounding: '2337.70',
      roundOff: '0.30',
      grandTotal: '2338.00',
    });
    expect(result.amountInWords).toBe('Rupees Two Thousand Three Hundred Thirty Eight Only');
    expect(result.engineVersion).toBe(GST_ENGINE_VERSION);
  });

  it('summarises tax by rate, ascending', () => {
    expect(result.taxSummary).toEqual([
      {
        gstRatePercent: '12',
        taxableAmount: '765.00',
        cgstAmount: '45.90',
        sgstAmount: '45.90',
        igstAmount: '0.00',
        totalTax: '91.80',
      },
      {
        gstRatePercent: '18',
        taxableAmount: '1255.00',
        cgstAmount: '112.95',
        sgstAmount: '112.95',
        igstAmount: '0.00',
        totalTax: '225.90',
      },
    ]);
  });
});

describe('calculateInvoice — inter-state (IGST)', () => {
  it('applies the full rate as IGST and rounds discount half-up', () => {
    const r = calculateInvoice({
      supplierStateCode: '27',
      placeOfSupplyStateCode: '29',
      policy: DEFAULT_GST_POLICY,
      lines: [
        line({
          lineNo: 1,
          quantity: '3',
          unitRate: '999.99',
          discountPercent: '5',
          gstRatePercent: '18',
        }),
      ],
    });
    expect(r.supplyType).toBe('INTER_STATE');
    expect(r.lines[0]).toMatchObject({
      grossAmount: '2999.97',
      discountAmount: '150.00', // 149.9985 → 150.00
      taxableAmount: '2849.97',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstRatePercent: '18',
      igstAmount: '512.99', // 512.9946 → 512.99
      lineTotal: '3362.96',
    });
    expect(r.totals.roundOff).toBe('0.04');
    expect(r.totals.grandTotal).toBe('3363.00');
  });
});

describe('rounding policy', () => {
  it('rounds an exact half paise up', () => {
    // 0.5% of 1.00 = 0.005 → 0.01 for both CGST and SGST
    const r = calculateInvoice(intra([line({ lineNo: 1, unitRate: '1', gstRatePercent: '1' })]));
    expect(r.lines[0]?.cgstAmount).toBe('0.01');
    expect(r.lines[0]?.sgstAmount).toBe('0.01');
  });

  it('rounds CGST and SGST separately per line (split-rounding effect)', () => {
    // 9% of 85.08 = 7.6572 → 7.66 for each half, so tax is 15.32 — not round(18% × 85.08) = 15.31.
    // This difference is exactly what the CA must confirm (LINE_HALF_UP policy).
    const r = calculateInvoice(
      intra([line({ lineNo: 1, unitRate: '85.08', gstRatePercent: '18' })]),
    );
    expect(r.lines[0]?.cgstAmount).toBe('7.66');
    expect(r.totals.totalTax).toBe('15.32');
  });

  it('produces a negative round-off when rounding down', () => {
    // 85.08 + 15.32 = 100.40 → 100.00
    const r = calculateInvoice(
      intra([line({ lineNo: 1, unitRate: '85.08', gstRatePercent: '18' })]),
    );
    expect(r.totals.totalBeforeRounding).toBe('100.40');
    expect(r.totals.roundOff).toBe('-0.40');
    expect(r.totals.grandTotal).toBe('100.00');
  });

  it('does not round the total when policy is NONE', () => {
    const r = calculateInvoice({
      ...intra([line({ lineNo: 1, unitRate: '85.08' })]),
      policy: { ...DEFAULT_GST_POLICY, invoiceRounding: 'NONE' },
    });
    expect(r.totals.roundOff).toBe('0.00');
    expect(r.totals.grandTotal).toBe('100.40');
    expect(r.amountInWords).toBe('Rupees One Hundred and Forty Paise Only');
  });

  it('handles zero-rated lines', () => {
    const r = calculateInvoice(intra([line({ lineNo: 1, unitRate: '500', gstRatePercent: '0' })]));
    expect(r.totals.totalTax).toBe('0.00');
    expect(r.totals.grandTotal).toBe('500.00');
  });

  it('orders lines by line number regardless of input order', () => {
    const r = calculateInvoice(intra([line({ lineNo: 2 }), line({ lineNo: 1, unitRate: '50' })]));
    expect(r.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });
});

describe('validation', () => {
  const expectIssues = (input: InvoiceCalcInput, paths: string[]) => {
    try {
      calculateInvoice(input);
      expect.unreachable('expected GstCalculationError');
    } catch (e) {
      expect(e).toBeInstanceOf(GstCalculationError);
      expect((e as GstCalculationError).issues.map((i) => i.path).sort()).toEqual(
        [...paths].sort(),
      );
    }
  };

  it('requires at least one line', () => {
    expectIssues(intra([]), ['lines']);
  });

  it('rejects bad state codes', () => {
    expectIssues(
      { ...intra([line({ lineNo: 1 })]), supplierStateCode: 'MH', placeOfSupplyStateCode: '1' },
      ['supplierStateCode', 'placeOfSupplyStateCode'],
    );
  });

  it('collects every line problem', () => {
    expectIssues(
      intra([
        line({ lineNo: 1, quantity: '0' }),
        line({
          lineNo: 1,
          quantity: '1.2345',
          unitRate: '-1',
          discountPercent: '150',
          gstRatePercent: 'x',
        }),
      ]),
      [
        'lines[0].quantity',
        'lines[1].lineNo',
        'lines[1].quantity',
        'lines[1].unitRate',
        'lines[1].discountPercent',
        'lines[1].gstRatePercent',
      ],
    );
  });

  it('rejects JavaScript numbers smuggled in as amounts', () => {
    expectIssues(intra([line({ lineNo: 1, unitRate: 10.5 as unknown as string })]), [
      'lines[0].unitRate',
    ]);
  });
});

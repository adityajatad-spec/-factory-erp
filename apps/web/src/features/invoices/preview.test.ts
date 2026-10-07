import { describe, expect, it } from 'vitest';
import { previewInvoice } from './preview';

describe('previewInvoice', () => {
  it('previews totals with the shared GST engine', () => {
    const r = previewInvoice({
      supplierStateCode: '27',
      placeOfSupplyStateCode: '27',
      lines: [{ quantity: '10', unitRate: '125.50', discountPercent: '', gstRatePercent: '18' }],
    });
    expect(r.ok && r.result.totals.grandTotal).toBe('1481.00');
  });

  it('ignores incomplete lines and waits for enough input', () => {
    expect(
      previewInvoice({ supplierStateCode: '27', placeOfSupplyStateCode: undefined, lines: [] }),
    ).toEqual({ ok: false, message: null });
    const r = previewInvoice({
      supplierStateCode: '27',
      placeOfSupplyStateCode: '24',
      lines: [
        { quantity: '', unitRate: '', discountPercent: '', gstRatePercent: null },
        { quantity: '1', unitRate: '100', discountPercent: '0', gstRatePercent: '18' },
      ],
    });
    expect(r.ok && r.result.totals.igstAmount).toBe('18.00');
  });

  it('reports invalid input instead of throwing', () => {
    const r = previewInvoice({
      supplierStateCode: '27',
      placeOfSupplyStateCode: '27',
      lines: [{ quantity: '1.23456', unitRate: '1', discountPercent: '0', gstRatePercent: '18' }],
    });
    expect(r.ok).toBe(false);
  });
});

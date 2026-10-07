import type { InvoiceDetailLineDto } from '@factory-erp/contracts';
import { describe, expect, it } from 'vitest';
import { previewCreditNote, type CreditableInvoiceView, type CreditInput } from './credit-math';

const line = (overrides: Partial<InvoiceDetailLineDto> = {}): InvoiceDetailLineDto => ({
  lineNo: 1,
  itemId: 'i',
  itemCode: 'W-1',
  description: 'Widget',
  hsnCode: '7326',
  uom: 'NOS',
  quantity: '1.000',
  unitRate: '8474.5800',
  discountPercent: '0',
  gstRatePercent: '18',
  grossAmount: '8474.58',
  discountAmount: '0.00',
  taxableAmount: '8474.58',
  cgstRatePercent: '9',
  cgstAmount: '762.71',
  sgstRatePercent: '9',
  sgstAmount: '762.71',
  igstRatePercent: '0',
  igstAmount: '0.00',
  lineTotal: '10000.00',
  creditedQuantity: '0.000',
  creditedTaxableAmount: '0.00',
  ...overrides,
});

const invoice = (overrides: Partial<CreditableInvoiceView> = {}): CreditableInvoiceView => ({
  supplierStateCode: '27',
  placeOfSupplyStateCode: '27',
  invoiceRounding: 'NEAREST_RUPEE',
  outstandingAmount: '10000.00',
  lines: [line()],
  ...overrides,
});

const inputs = (quantity: string, unitRate: string) =>
  new Map<number, CreditInput>([[1, { quantity, unitRate }]]);

describe('previewCreditNote', () => {
  it('prices a partial credit like the server (₹2,000 of a ₹10,000 invoice)', () => {
    const p = previewCreditNote(invoice(), inputs('1', '1694.92'));
    expect(p.totalError).toBeNull();
    expect(p.result?.totals.grandTotal).toBe('2000.00');
    expect(p.outstandingAfter).toBe('8000.00');
    expect(p.lines).toEqual([{ invoiceLineNo: 1, quantity: '1', unitRate: '1694.92' }]);
  });

  it('a full credit reproduces the invoice total exactly', () => {
    const p = previewCreditNote(invoice(), inputs('1', '8474.58'));
    expect(p.result?.totals.grandTotal).toBe('10000.00');
    expect(p.outstandingAfter).toBe('0.00');
  });

  it('flags quantity and rate above the invoice line', () => {
    expect(previewCreditNote(invoice(), inputs('2', '100')).lineErrors.get(1)).toMatch(
      /Only 1.000 NOS were invoiced/,
    );
    expect(previewCreditNote(invoice(), inputs('1', '9000')).lineErrors.get(1)).toMatch(
      /above the invoiced rate/,
    );
  });

  it('flags crediting more of a line than is left, and more than is outstanding', () => {
    const credited = invoice({ lines: [line({ creditedTaxableAmount: '8000.00' })] });
    expect(previewCreditNote(credited, inputs('1', '474.59')).lineErrors.get(1)).toMatch(
      /Only ₹474.58 of this line is left/,
    );
    const paid = invoice({ outstandingAmount: '1000.00' });
    expect(previewCreditNote(paid, inputs('1', '1694.92')).totalError).toBe(
      'Only ₹1,000.00 is outstanding on this invoice',
    );
  });

  it('ignores blank lines and reports nothing to credit', () => {
    const p = previewCreditNote(invoice(), inputs('', '100'));
    expect(p.lines).toEqual([]);
    expect(p.result).toBeNull();
    expect(p.totalError).toBeNull();
  });
});

import { Money } from '@factory-erp/money';
import { describe, expect, it } from 'vitest';
import { outstandingOf, paymentStatusOf } from '../sales/settlement';
import { ageingBucketOf, checkAllocations, type SettleableInvoice } from './domain';

const inv = (
  id: string,
  outstanding: string,
  overrides: Partial<SettleableInvoice> = {},
): SettleableInvoice => ({
  id,
  invoiceNumber: `INV/${id}`,
  customerId: 'c1',
  status: 'ISSUED',
  outstanding: Money.of(outstanding),
  ...overrides,
});

const invoices = new Map([
  ['a', inv('a', '1000.00')],
  ['b', inv('b', '250.50')],
  ['draft', inv('draft', '99.00', { status: 'DRAFT', invoiceNumber: null })],
  ['other', inv('other', '500.00', { customerId: 'c2' })],
]);

const check = (available: string, requests: Array<{ invoiceId: string; amount: string }>) =>
  checkAllocations({ customerId: 'c1', available: Money.of(available), invoices, requests });

describe('checkAllocations', () => {
  it('accepts full and partial allocations across several invoices', () => {
    const r = check('1250.50', [
      { invoiceId: 'a', amount: '1000.00' },
      { invoiceId: 'b', amount: '250.50' },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.total.toString()).toBe('1250.50');
    expect(check('600', [{ invoiceId: 'a', amount: '600' }]).issues).toEqual([]);
  });

  it('allows leaving part of the receipt unallocated (overpayment rule)', () => {
    const r = check('5000', [{ invoiceId: 'b', amount: '250.50' }]);
    expect(r.issues).toEqual([]);
  });

  it('rejects allocating more than an invoice still owes', () => {
    const r = check('5000', [{ invoiceId: 'b', amount: '250.51' }]);
    expect(r.issues.map((i) => i.rule)).toEqual(['EXCEEDS_INVOICE_OUTSTANDING']);
    expect(r.issues[0]?.path).toBe('allocations.0.amount');
  });

  it('rejects allocating more than the receipt has available', () => {
    const r = check('1000', [
      { invoiceId: 'a', amount: '900' },
      { invoiceId: 'b', amount: '100.01' },
    ]);
    expect(r.issues.map((i) => i.rule)).toEqual(['EXCEEDS_RECEIPT_AVAILABLE']);
  });

  it('rejects drafts, other customers, unknown and duplicate invoices', () => {
    const r = check('9999', [
      { invoiceId: 'draft', amount: '1' },
      { invoiceId: 'other', amount: '1' },
      { invoiceId: 'nope', amount: '1' },
      { invoiceId: 'a', amount: '1' },
      { invoiceId: 'a', amount: '1' },
    ]);
    expect(r.issues.map((i) => i.rule)).toEqual([
      'INVOICE_NOT_ISSUED',
      'CUSTOMER_MISMATCH',
      'INVOICE_NOT_FOUND',
      'DUPLICATE_INVOICE',
    ]);
  });
});

describe('paymentStatusOf (derived settlement)', () => {
  it.each([
    ['ISSUED', '100.00', '0.00', '0.00', 'UNPAID'],
    ['ISSUED', '100.00', '0.01', '0.00', 'PARTIALLY_PAID'],
    ['ISSUED', '100.00', '99.99', '0.00', 'PARTIALLY_PAID'],
    ['ISSUED', '100.00', '100.00', '0.00', 'PAID'],
    ['ISSUED', '0.00', '0.00', '0.00', 'PAID'],
    // Credit notes reduce what is owed without being money received.
    ['ISSUED', '100.00', '0.00', '20.00', 'UNPAID'],
    ['ISSUED', '100.00', '60.00', '20.00', 'PARTIALLY_PAID'],
    ['ISSUED', '100.00', '80.00', '20.00', 'PAID'],
    ['ISSUED', '100.00', '0.00', '100.00', 'CREDITED'],
    ['DRAFT', '100.00', '0.00', '0.00', null],
    ['CANCELLED', '100.00', '0.00', '0.00', null],
  ] as const)('%s total %s paid %s credited %s → %s', (status, total, paid, credited, expected) => {
    expect(paymentStatusOf(status, total, paid, credited)).toBe(expected);
  });

  it('derives outstanding as total − paid − credited', () => {
    expect(outstandingOf('10000.00', '6000.00', '2000.00')).toBe('2000.00');
    expect(outstandingOf('10000.00', '0.00', '10000.00')).toBe('0.00');
  });
});

describe('ageingBucketOf', () => {
  it.each([
    [0, 'd0_30'],
    [30, 'd0_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90_plus'],
    [400, 'd90_plus'],
    [-3, 'd0_30'],
  ] as const)('%s days → %s', (days, bucket) => {
    expect(ageingBucketOf(days)).toBe(bucket);
  });
});

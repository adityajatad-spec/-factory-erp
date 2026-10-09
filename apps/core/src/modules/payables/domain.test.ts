import fc from 'fast-check';
import { Money } from '@factory-erp/money';
import { describe, expect, it } from 'vitest';
import { checkSupplierAllocations, type PayableBill } from './domain';

const bill = (id: string, outstanding: string, o: Partial<PayableBill> = {}): PayableBill => ({
  id,
  label: `PI/${id}`,
  supplierId: 's1',
  status: 'POSTED',
  outstanding: Money.of(outstanding),
  ...o,
});

const bills = new Map([
  ['a', bill('a', '5900.00')],
  ['b', bill('b', '1180.00')],
  ['draft', bill('draft', '10.00', { status: 'DRAFT' })],
  ['other', bill('other', '500.00', { supplierId: 's2' })],
]);

const check = (available: string, requests: Array<{ purchaseInvoiceId: string; amount: string }>) =>
  checkSupplierAllocations({ supplierId: 's1', available: Money.of(available), bills, requests });
const rules = (r: ReturnType<typeof check>) => r.issues.map((i) => i.rule);

describe('supplier payment allocation rules', () => {
  it('accepts full, partial and multi-bill allocations, and leaving money on account', () => {
    expect(
      check('7080.00', [
        { purchaseInvoiceId: 'a', amount: '5900.00' },
        { purchaseInvoiceId: 'b', amount: '1180.00' },
      ]).issues,
    ).toEqual([]);
    expect(check('10000.00', [{ purchaseInvoiceId: 'a', amount: '2000.00' }]).issues).toEqual([]);
    expect(check('10000.00', []).issues).toEqual([]);
  });

  it('refuses drafts, other suppliers, unknown and repeated bills', () => {
    expect(rules(check('100', [{ purchaseInvoiceId: 'draft', amount: '1' }]))).toEqual([
      'INVOICE_NOT_POSTED',
    ]);
    expect(rules(check('100', [{ purchaseInvoiceId: 'other', amount: '1' }]))).toEqual([
      'SUPPLIER_MISMATCH',
    ]);
    expect(rules(check('100', [{ purchaseInvoiceId: 'zzz', amount: '1' }]))).toEqual([
      'INVOICE_NOT_FOUND',
    ]);
    expect(
      rules(
        check('100', [
          { purchaseInvoiceId: 'a', amount: '1' },
          { purchaseInvoiceId: 'a', amount: '1' },
        ]),
      ),
    ).toEqual(['DUPLICATE_INVOICE']);
  });

  it('never pays a bill beyond its outstanding, or more than the payment has left', () => {
    expect(rules(check('9999', [{ purchaseInvoiceId: 'b', amount: '1180.01' }]))).toEqual([
      'EXCEEDS_INVOICE_OUTSTANDING',
    ]);
    expect(rules(check('1000.00', [{ purchaseInvoiceId: 'a', amount: '1000.01' }]))).toEqual([
      'EXCEEDS_PAYMENT_AVAILABLE',
    ]);
  });

  it('property: accepted requests never over-allocate a bill or the payment', () => {
    // Amounts are built from whole paise with integer arithmetic, never floats.
    const rupees = (n: number) => `${Math.trunc(n / 100)}.${String(n % 100).padStart(2, '0')}`;
    const paise = fc.integer({ min: 1, max: 800_000 }).map(rupees);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }).map(rupees),
        fc.subarray(['a', 'b']),
        fc.array(paise, { minLength: 2, maxLength: 2 }),
        (available, ids, amounts) => {
          const requests = ids.map((id, i) => ({ purchaseInvoiceId: id, amount: amounts[i]! }));
          const r = check(available, requests);
          if (r.issues.length === 0) {
            expect(r.total.compare(Money.of(available))).toBeLessThanOrEqual(0);
            for (const q of requests) {
              const b = bills.get(q.purchaseInvoiceId)!;
              expect(Money.of(q.amount).compare(b.outstanding)).toBeLessThanOrEqual(0);
            }
          }
        },
      ),
    );
  });
});

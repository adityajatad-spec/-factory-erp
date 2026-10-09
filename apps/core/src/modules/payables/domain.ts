import { Money } from '@factory-erp/money';

/**
 * Supplier-payment allocation rules — pure, no I/O. The mirror of customer receipts.
 *
 *  1. Money can be allocated only to POSTED purchase invoices of the payment's supplier.
 *  2. An allocation may not exceed the bill's outstanding amount
 *     (outstanding = grand total − Σ existing allocations; always derived).
 *  3. Σ allocations of a payment may not exceed what is left of the payment.
 *  4. Requests are validated whole: nothing is silently capped or partially applied.
 *
 * ON-ACCOUNT RULE (explicit)
 *  A payment may be larger than the bills it settles — or settle none. The rest stays
 *  UNALLOCATED on the payment: an advance to the supplier that lowers what we owe (the
 *  balance may go negative: the supplier owes us) and can be allocated to later bills with an
 *  explicit allocate command. Refunds are not modelled yet.
 *  [CA validation point] Tax treatment of advances paid to suppliers must be confirmed.
 */

export interface PayableBill {
  id: string;
  label: string;
  supplierId: string;
  status: string;
  outstanding: Money;
}

export interface SupplierAllocationRequest {
  purchaseInvoiceId: string;
  amount: string;
}

export interface SupplierAllocationIssue {
  path: string;
  rule:
    | 'INVOICE_NOT_FOUND'
    | 'INVOICE_NOT_POSTED'
    | 'SUPPLIER_MISMATCH'
    | 'DUPLICATE_INVOICE'
    | 'EXCEEDS_INVOICE_OUTSTANDING'
    | 'EXCEEDS_PAYMENT_AVAILABLE';
  message: string;
}

export function checkSupplierAllocations(args: {
  supplierId: string;
  /** What is left of the payment to allocate. */
  available: Money;
  bills: ReadonlyMap<string, PayableBill>;
  requests: readonly SupplierAllocationRequest[];
}): { total: Money; issues: SupplierAllocationIssue[] } {
  const issues: SupplierAllocationIssue[] = [];
  const seen = new Set<string>();
  let total = Money.zero();

  args.requests.forEach((req, i) => {
    const path = `allocations.${i}`;
    const amount = Money.of(req.amount);
    total = total.plus(amount);

    if (seen.has(req.purchaseInvoiceId)) {
      issues.push({ path, rule: 'DUPLICATE_INVOICE', message: 'Bill listed more than once' });
      return;
    }
    seen.add(req.purchaseInvoiceId);

    const bill = args.bills.get(req.purchaseInvoiceId);
    if (!bill) {
      issues.push({ path, rule: 'INVOICE_NOT_FOUND', message: 'Purchase invoice not found' });
      return;
    }
    if (bill.status !== 'POSTED') {
      issues.push({
        path,
        rule: 'INVOICE_NOT_POSTED',
        message: `${bill.label} is a draft; only posted bills can be paid`,
      });
      return;
    }
    if (bill.supplierId !== args.supplierId) {
      issues.push({
        path,
        rule: 'SUPPLIER_MISMATCH',
        message: `${bill.label} is from a different supplier`,
      });
      return;
    }
    if (amount.compare(bill.outstanding) > 0) {
      issues.push({
        path: `${path}.amount`,
        rule: 'EXCEEDS_INVOICE_OUTSTANDING',
        message: `${bill.label} has only ₹${bill.outstanding.toString()} outstanding; cannot allocate ₹${amount.toString()}`,
      });
    }
  });

  if (total.compare(args.available) > 0) {
    issues.push({
      path: 'allocations',
      rule: 'EXCEEDS_PAYMENT_AVAILABLE',
      message: `Allocations total ₹${total.toString()} but only ₹${args.available.toString()} of the payment is unallocated`,
    });
  }
  return { total, issues };
}

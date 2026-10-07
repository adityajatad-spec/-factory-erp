import { AGEING_BUCKETS, type AgeingBucketKey } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';

/**
 * Receivables domain rules — pure, no I/O.
 *
 * ALLOCATION RULES
 *  1. Money can be allocated only to ISSUED invoices of the receipt's customer.
 *  2. An allocation may not exceed the invoice's outstanding amount
 *     (outstanding = grand total − Σ existing allocations − Σ issued credit notes; always
 *     derived).
 *  3. Σ allocations of a receipt may not exceed the receipt amount.
 *  4. Requests are validated whole: nothing is silently capped or partially applied.
 *
 * OVERPAYMENT RULE (explicit)
 *  A receipt may be larger than everything the customer currently owes. The excess is kept
 *  as an UNALLOCATED (on-account) credit on that receipt: it lowers the customer's balance —
 *  which may go negative, meaning the customer holds a credit with us — and can be allocated
 *  to future invoices with an explicit allocate command. Refunds are not modelled yet.
 *  [CA validation point] Tax treatment of advances/on-account receipts must be confirmed.
 */

export interface SettleableInvoice {
  id: string;
  invoiceNumber: string | null;
  customerId: string;
  status: string;
  outstanding: Money;
}

export interface AllocationRequest {
  invoiceId: string;
  amount: string;
}

export interface AllocationIssue {
  path: string;
  rule:
    | 'INVOICE_NOT_FOUND'
    | 'INVOICE_NOT_ISSUED'
    | 'CUSTOMER_MISMATCH'
    | 'DUPLICATE_INVOICE'
    | 'EXCEEDS_INVOICE_OUTSTANDING'
    | 'EXCEEDS_RECEIPT_AVAILABLE';
  message: string;
}

export function checkAllocations(args: {
  customerId: string;
  /** Receipt amount not yet allocated. */
  available: Money;
  invoices: ReadonlyMap<string, SettleableInvoice>;
  requests: readonly AllocationRequest[];
}): { total: Money; issues: AllocationIssue[] } {
  const issues: AllocationIssue[] = [];
  const seen = new Set<string>();
  let total = Money.zero();

  args.requests.forEach((req, i) => {
    const path = `allocations.${i}`;
    const amount = Money.of(req.amount);
    total = total.plus(amount);

    if (seen.has(req.invoiceId)) {
      issues.push({ path, rule: 'DUPLICATE_INVOICE', message: 'Invoice listed more than once' });
      return;
    }
    seen.add(req.invoiceId);

    const inv = args.invoices.get(req.invoiceId);
    if (!inv) {
      issues.push({ path, rule: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
      return;
    }
    const label = inv.invoiceNumber ?? 'draft invoice';
    if (inv.status !== 'ISSUED') {
      issues.push({
        path,
        rule: 'INVOICE_NOT_ISSUED',
        message: `${label} is ${inv.status}; only issued invoices can be paid`,
      });
      return;
    }
    if (inv.customerId !== args.customerId) {
      issues.push({
        path,
        rule: 'CUSTOMER_MISMATCH',
        message: `${label} belongs to a different customer`,
      });
      return;
    }
    if (amount.compare(inv.outstanding) > 0) {
      issues.push({
        path: `${path}.amount`,
        rule: 'EXCEEDS_INVOICE_OUTSTANDING',
        message: `${label} has only ₹${inv.outstanding.toString()} outstanding; cannot allocate ₹${amount.toString()}`,
      });
    }
  });

  if (total.compare(args.available) > 0) {
    issues.push({
      path: 'allocations',
      rule: 'EXCEEDS_RECEIPT_AVAILABLE',
      message: `Allocations total ₹${total.toString()} but only ₹${args.available.toString()} of the receipt is unallocated`,
    });
  }
  return { total, issues };
}

export function ageingBucketOf(ageDays: number): AgeingBucketKey {
  const bucket = AGEING_BUCKETS.find(
    (b) => ageDays >= b.minDays && (b.maxDays === null || ageDays <= b.maxDays),
  );
  // Ages are never negative (invoices cannot be future-dated), but clamp defensively.
  return bucket?.key ?? 'd0_30';
}

export function emptyAgeing(): Record<AgeingBucketKey, Money> {
  return {
    d0_30: Money.zero(),
    d31_60: Money.zero(),
    d61_90: Money.zero(),
    d90_plus: Money.zero(),
  };
}

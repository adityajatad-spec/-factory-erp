import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../db/database';
import type { AuditRecord } from '../../platform/audit';
import { BusinessRuleError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { lockPurchaseInvoicesForSettlement, outstandingOfPurchase } from '../purchasing';
import {
  checkSupplierAllocations,
  type PayableBill,
  type SupplierAllocationRequest,
} from './domain';

export interface AppliedSupplierAllocation {
  purchaseInvoiceId: string;
  invoiceNumber: string | null;
  amount: string;
  outstandingBefore: string;
  outstandingAfter: string;
}

/**
 * Apply allocations from one approved supplier payment, inside the caller's transaction.
 *
 * The caller must already hold the payment row locked, so `alreadyAllocated` is stable. The
 * bills are locked here (in id order) and every rule is checked on the locked state; the
 * request is rejected whole on any violation. SQL re-checks at COMMIT (FO005).
 */
export async function applySupplierAllocations(
  tx: DbTransaction,
  args: {
    companyId: string;
    payment: { id: string; supplierId: string; amount: string; alreadyAllocated: string };
    requests: readonly SupplierAllocationRequest[];
    userId: string;
    now: Date;
  },
): Promise<AppliedSupplierAllocation[]> {
  if (args.requests.length === 0) return [];
  const locked = await lockPurchaseInvoicesForSettlement(
    tx,
    args.companyId,
    args.requests.map((r) => r.purchaseInvoiceId),
  );
  const bills = new Map<string, PayableBill & { invoiceNumber: string | null }>(
    locked.map((b) => [
      b.id,
      {
        id: b.id,
        invoiceNumber: b.invoiceNumber,
        label: b.invoiceNumber ?? `draft bill ${b.supplierInvoiceNumber}`,
        supplierId: b.supplierId,
        status: b.status,
        outstanding: Money.of(outstandingOfPurchase(b.grandTotal, b.paidAmount)),
      },
    ]),
  );

  const available = Money.of(args.payment.amount).minus(Money.of(args.payment.alreadyAllocated));
  const { issues } = checkSupplierAllocations({
    supplierId: args.payment.supplierId,
    available,
    bills,
    requests: args.requests,
  });
  const first = issues[0];
  if (first) {
    throw new BusinessRuleError(
      first.rule,
      issues.map((i) => i.message).join('; '),
      issues.map(({ path, message }) => ({ path, message })),
    );
  }

  await tx
    .insertInto('finance.supplierPaymentAllocations')
    .values(
      args.requests.map((r) => ({
        id: uuidv7(args.now.getTime()),
        companyId: args.companyId,
        paymentId: args.payment.id,
        purchaseInvoiceId: r.purchaseInvoiceId,
        amount: Money.of(r.amount).toString(),
        allocatedAt: args.now,
        allocatedBy: args.userId,
      })),
    )
    .execute();

  return args.requests.map((r) => {
    const b = bills.get(r.purchaseInvoiceId);
    if (!b) throw new Error('unreachable: bill validated above');
    return {
      purchaseInvoiceId: r.purchaseInvoiceId,
      invoiceNumber: b.invoiceNumber,
      amount: Money.of(r.amount).toString(),
      outstandingBefore: b.outstanding.toString(),
      outstandingAfter: b.outstanding.minus(Money.of(r.amount)).toString(),
    };
  });
}

/** One audit record per bill, so each bill's history shows the payment. */
export function billAuditRecords(
  applied: readonly AppliedSupplierAllocation[],
  paymentNumber: string | null,
): AuditRecord[] {
  return applied.map((a) => ({
    entityType: 'purchase.invoice',
    entityId: a.purchaseInvoiceId,
    before: { outstandingAmount: a.outstandingBefore },
    after: { outstandingAmount: a.outstandingAfter, allocatedAmount: a.amount, paymentNumber },
  }));
}

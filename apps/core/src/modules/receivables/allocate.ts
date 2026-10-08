import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../db/database';
import type { AuditRecord } from '../../platform/audit';
import { BusinessRuleError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { lockInvoicesForSettlement, outstandingOf } from '../sales';
import { checkAllocations, type AllocationRequest, type SettleableInvoice } from './domain';

export interface AppliedAllocation {
  invoiceId: string;
  invoiceNumber: string | null;
  amount: string;
  outstandingBefore: string;
  outstandingAfter: string;
}

/**
 * Apply allocations from one receipt, inside the caller's transaction.
 *
 * The caller must already hold the receipt (a new row, or one locked FOR UPDATE) so
 * `alreadyAllocated` is stable. Target invoices are locked here; all rules are checked on
 * the locked state, and the request is rejected whole on any violation.
 */
export async function applyAllocations(
  tx: DbTransaction,
  args: {
    companyId: string;
    receipt: { id: string; customerId: string; amount: string; alreadyAllocated: string };
    requests: readonly AllocationRequest[];
    userId: string;
    now: Date;
  },
): Promise<AppliedAllocation[]> {
  const locked = await lockInvoicesForSettlement(
    tx,
    args.companyId,
    args.requests.map((r) => r.invoiceId),
  );
  const invoices = new Map<string, SettleableInvoice>(
    locked.map((i) => [
      i.id,
      {
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        customerId: i.customerId,
        status: i.status,
        outstanding: Money.of(outstandingOf(i.grandTotal, i.paidAmount, i.creditedAmount)),
      },
    ]),
  );

  const available = Money.of(args.receipt.amount).minus(Money.of(args.receipt.alreadyAllocated));
  const { issues } = checkAllocations({
    customerId: args.receipt.customerId,
    available,
    invoices,
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
    .insertInto('finance.receiptAllocations')
    .values(
      args.requests.map((r) => ({
        id: uuidv7(args.now.getTime()),
        companyId: args.companyId,
        receiptId: args.receipt.id,
        invoiceId: r.invoiceId,
        amount: Money.of(r.amount).toString(),
        allocatedAt: args.now,
        allocatedBy: args.userId,
      })),
    )
    .execute();

  return args.requests.map((r) => {
    const inv = invoices.get(r.invoiceId);
    if (!inv) throw new Error('unreachable: invoice validated above');
    return {
      invoiceId: r.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      amount: Money.of(r.amount).toString(),
      outstandingBefore: inv.outstanding.toString(),
      outstandingAfter: inv.outstanding.minus(Money.of(r.amount)).toString(),
    };
  });
}

/** One audit record per affected invoice, so each invoice's history shows the payment. */
export function invoiceAuditRecords(
  applied: readonly AppliedAllocation[],
  receiptNumber: string,
): AuditRecord[] {
  return applied.map((a) => ({
    entityType: 'sales.invoice',
    entityId: a.invoiceId,
    before: { outstandingAmount: a.outstandingBefore },
    after: { outstandingAmount: a.outstandingAfter, allocatedAmount: a.amount, receiptNumber },
  }));
}

import type { InvoiceStatus, PaymentStatus } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql, type RawBuilder } from 'kysely';

/**
 * Invoice settlement is DERIVED, never stored:
 *   outstanding = grand total − Σ allocations − Σ issued credit notes.
 * This module is the single definition of that rule for the sales read model (the SQL view
 * finance.invoice_balances mirrors it for reporting).
 */
export function paymentStatusOf(
  status: InvoiceStatus,
  grandTotal: string,
  paidAmount: string,
  creditedAmount: string,
): PaymentStatus | null {
  if (status !== 'ISSUED') return null;
  const paid = Money.of(paidAmount);
  const outstanding = Money.of(outstandingOf(grandTotal, paidAmount, creditedAmount));
  if (outstanding.isPositive()) return paid.isZero() ? 'UNPAID' : 'PARTIALLY_PAID';
  // Settled. Credit notes alone (no money received) mean it was credited, not paid; a
  // zero-value invoice owes nothing, so it counts as paid.
  return paid.isZero() && Money.of(creditedAmount).isPositive() ? 'CREDITED' : 'PAID';
}

export function outstandingOf(grandTotal: string, paidAmount: string, creditedAmount: string) {
  return Money.of(grandTotal)
    .minus(Money.of(paidAmount))
    .minus(Money.of(creditedAmount))
    .toString();
}

const paidSum = sql`(select coalesce(sum(a.amount), 0)
    from finance.receipt_allocations a where a.invoice_id = ${sql.ref('inv.id')})`;
const creditedSum = sql`(select coalesce(sum(cn.grand_total), 0)
    from sales.credit_notes cn where cn.invoice_id = ${sql.ref('inv.id')} and cn.status = 'ISSUED')`;

/**
 * Σ allocations against the invoice aliased `inv` (read-only view onto the receivables
 * ledger; the receivables module owns the writes).
 */
export const paidAmountSql: RawBuilder<string> = sql<string>`${paidSum}::numeric(18,2)::text`;

/** Σ issued credit notes against the invoice aliased `inv`. */
export const creditedAmountSql: RawBuilder<string> = sql<string>`${creditedSum}::numeric(18,2)::text`;

/** Derived outstanding of the invoice aliased `inv`, as a number for SQL comparisons. */
export const outstandingSql = sql`(${sql.ref('inv.grandTotal')} - ${paidSum} - ${creditedSum})`;

/** SQL predicate for a payment status on invoices aliased `inv` (mirrors paymentStatusOf). */
export function paymentStatusPredicate(status: PaymentStatus): RawBuilder<boolean> {
  const issued = sql`${sql.ref('inv.status')} = 'ISSUED'`;
  switch (status) {
    case 'UNPAID':
      return sql<boolean>`(${issued} and ${outstandingSql} > 0 and ${paidSum} = 0)`;
    case 'PARTIALLY_PAID':
      return sql<boolean>`(${issued} and ${outstandingSql} > 0 and ${paidSum} > 0)`;
    case 'PAID':
      return sql<boolean>`(${issued} and ${outstandingSql} <= 0 and (${paidSum} > 0 or ${creditedSum} = 0))`;
    case 'CREDITED':
      return sql<boolean>`(${issued} and ${outstandingSql} <= 0 and ${paidSum} = 0 and ${creditedSum} > 0)`;
  }
}

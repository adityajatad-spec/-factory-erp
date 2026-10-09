import type { PayableStatus } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql, type RawBuilder } from 'kysely';
import type { DbTransaction } from '../../../db/database';

/**
 * Purchase-invoice settlement is DERIVED, never stored:
 *   outstanding = grand total − Σ supplier-payment allocations.
 * (The SQL view finance.purchase_invoice_balances mirrors it for reporting.)
 */
export function outstandingOfPurchase(grandTotal: string, paidAmount: string): string {
  return Money.of(grandTotal).minus(Money.of(paidAmount)).toString();
}

export function payableStatusOf(
  status: string,
  grandTotal: string,
  paidAmount: string,
): PayableStatus | null {
  if (status !== 'POSTED') return null;
  if (Money.of(outstandingOfPurchase(grandTotal, paidAmount)).isPositive()) {
    return Money.of(paidAmount).isZero() ? 'UNPAID' : 'PARTIALLY_PAID';
  }
  return 'PAID';
}

/** Σ allocations against the purchase invoice aliased `pi` (the payables module owns the writes). */
export const purchasePaidSql: RawBuilder<string> = sql<string>`(select coalesce(sum(a.amount), 0)
    from finance.supplier_payment_allocations a
   where a.purchase_invoice_id = ${sql.ref('pi.id')})::numeric(18,2)::text`;

export interface PurchaseInvoiceForSettlement {
  id: string;
  invoiceNumber: string | null;
  supplierInvoiceNumber: string;
  supplierId: string;
  status: string;
  grandTotal: string;
  paidAmount: string;
}

/**
 * Lock purchase invoices for settlement and read what has been paid AFTER the locks are held,
 * so concurrent payments against the same bill serialise and cannot over-pay it. Rows are
 * locked in id order so overlapping settlements cannot deadlock.
 */
export async function lockPurchaseInvoicesForSettlement(
  tx: DbTransaction,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<PurchaseInvoiceForSettlement[]> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return [];
  const rows = await tx
    .selectFrom('purchase.invoices')
    .select(['id', 'invoiceNumber', 'supplierInvoiceNumber', 'supplierId', 'status', 'grandTotal'])
    .where('companyId', '=', companyId)
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();
  const paid = await tx
    .selectFrom('finance.supplierPaymentAllocations')
    .select(['purchaseInvoiceId', (eb) => eb.fn.sum<string>('amount').as('paid')])
    .where('purchaseInvoiceId', 'in', ids)
    .groupBy('purchaseInvoiceId')
    .execute();
  const paidById = new Map(paid.map((p) => [p.purchaseInvoiceId, p.paid]));
  return rows.map((r) => ({ ...r, paidAmount: Money.of(paidById.get(r.id) ?? '0').toString() }));
}

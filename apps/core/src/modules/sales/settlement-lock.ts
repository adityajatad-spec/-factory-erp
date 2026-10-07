import type { DbTransaction } from '../../db/database';

export interface InvoiceForSettlement {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  customerId: string;
  status: string;
  version: number;
  grandTotal: string;
  paidAmount: string;
  creditedAmount: string;
}

/**
 * Lock invoices for settlement and read what has settled them AFTER the locks are held.
 *
 * Everything that changes an invoice's settlement position — allocating a payment, issuing a
 * credit note, cancelling the invoice — takes this lock first, so the paid and credited
 * amounts read here cannot change until the caller's transaction ends. Rows are locked in id
 * order so concurrent settlements touching overlapping invoices cannot deadlock.
 */
export async function lockInvoicesForSettlement(
  tx: DbTransaction,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<InvoiceForSettlement[]> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return [];
  const rows = await tx
    .selectFrom('sales.invoices')
    .select(['id', 'invoiceNumber', 'invoiceDate', 'customerId', 'status', 'version', 'grandTotal'])
    .where('companyId', '=', companyId)
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();

  const paid = await tx
    .selectFrom('finance.receiptAllocations')
    .select(['invoiceId', (eb) => eb.fn.sum<string>('amount').as('paid')])
    .where('invoiceId', 'in', ids)
    .groupBy('invoiceId')
    .execute();
  const credited = await tx
    .selectFrom('sales.creditNotes')
    .select(['invoiceId', (eb) => eb.fn.sum<string>('grandTotal').as('credited')])
    .where('invoiceId', 'in', ids)
    .where('status', '=', 'ISSUED')
    .groupBy('invoiceId')
    .execute();
  const paidById = new Map(paid.map((p) => [p.invoiceId, p.paid]));
  const creditedById = new Map(credited.map((c) => [c.invoiceId, c.credited]));

  return rows.map((r) => ({
    ...r,
    paidAmount: paidById.get(r.id) ?? '0',
    creditedAmount: creditedById.get(r.id) ?? '0',
  }));
}

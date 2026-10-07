import { z } from 'zod';
import type { DbTransaction } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';
import { creditedAmountSql, paidAmountSql } from '../settlement';
import { lockInvoicesForSettlement } from '../settlement-lock';
import type { CreditableInvoice, PricedCreditLine } from './rules';

/** The rounding policy stored on an issued invoice (the GST engine's GstPolicy). */
const StoredPolicy = z.object({
  lineRounding: z.literal('LINE_HALF_UP'),
  invoiceRounding: z.enum(['NEAREST_RUPEE', 'NONE']),
});

/**
 * Load an invoice in the shape the credit-note rules need. With `lock`, the invoice row is
 * locked for settlement first (see lockInvoicesForSettlement) and every amount is read after
 * the lock, so nothing can settle the invoice concurrently until the transaction ends.
 */
export async function loadCreditableInvoice(
  db: DbTransaction,
  companyId: string,
  invoiceId: string,
  opts: { lock: boolean },
): Promise<CreditableInvoice & { version: number }> {
  let settled: { paidAmount: string; creditedAmount: string } | undefined;
  if (opts.lock) {
    const [locked] = await lockInvoicesForSettlement(db, companyId, [invoiceId]);
    if (!locked) throw new NotFoundError('Invoice');
    settled = locked;
  }

  const h = await db
    .selectFrom('sales.invoices as inv')
    .select([
      'inv.id',
      'inv.invoiceNumber',
      'inv.invoiceDate',
      'inv.status',
      'inv.version',
      'inv.customerId',
      'inv.supplierStateCode',
      'inv.placeOfSupplyStateCode',
      'inv.gstPolicy',
      'inv.grandTotal',
    ])
    .select([paidAmountSql.as('paidAmount'), creditedAmountSql.as('creditedAmount')])
    .where('inv.companyId', '=', companyId)
    .where('inv.id', '=', invoiceId)
    .executeTakeFirst();
  if (!h) throw new NotFoundError('Invoice');

  const lines = await db
    .selectFrom('sales.invoiceLines as l')
    .select([
      'l.lineNo',
      'l.itemId',
      'l.description',
      'l.hsnCode',
      'l.uom',
      'l.quantity',
      'l.unitRate',
      'l.discountPercent',
      'l.gstRatePercent',
      'l.taxableAmount',
    ])
    .select((eb) =>
      eb
        .selectFrom('sales.creditNoteLines as cl')
        .innerJoin('sales.creditNotes as cn', 'cn.id', 'cl.creditNoteId')
        .select((e) => e.fn.coalesce(e.fn.sum<string>('cl.taxableAmount'), e.val('0')).as('t'))
        .whereRef('cl.invoiceId', '=', 'l.invoiceId')
        .whereRef('cl.invoiceLineNo', '=', 'l.lineNo')
        .where('cn.status', '=', 'ISSUED')
        .as('creditedTaxableAmount'),
    )
    .where('l.invoiceId', '=', invoiceId)
    .orderBy('l.lineNo')
    .execute();

  return {
    id: h.id,
    invoiceNumber: h.invoiceNumber,
    invoiceDate: h.invoiceDate,
    status: h.status,
    version: h.version,
    customerId: h.customerId,
    supplierStateCode: h.supplierStateCode,
    placeOfSupplyStateCode: h.placeOfSupplyStateCode,
    policy: StoredPolicy.parse(h.gstPolicy),
    grandTotal: h.grandTotal,
    paidAmount: settled?.paidAmount ?? h.paidAmount,
    creditedAmount: settled?.creditedAmount ?? h.creditedAmount,
    lines: lines.map((l) => ({ ...l, creditedTaxableAmount: l.creditedTaxableAmount ?? '0' })),
  };
}

/** Replace all lines of a DRAFT credit note (the SQL guard rejects this once issued). */
export async function replaceCreditNoteLines(
  tx: DbTransaction,
  creditNoteId: string,
  invoiceId: string,
  lines: readonly PricedCreditLine[],
): Promise<void> {
  await tx.deleteFrom('sales.creditNoteLines').where('creditNoteId', '=', creditNoteId).execute();
  if (lines.length === 0) return;
  await tx
    .insertInto('sales.creditNoteLines')
    .values(lines.map((l) => ({ ...l, creditNoteId, invoiceId })))
    .execute();
}

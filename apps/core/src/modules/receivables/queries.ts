import {
  ListReceiptsQuery,
  OpenInvoicesQuery,
  PERMISSIONS,
  Uuid,
  type OpenInvoiceDto,
  type ReceiptDto,
  type ReceiptListItemDto,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import type { DbExecutor } from '../../db/database';
import { businessDate, daysBetween } from '../../platform/clock';
import { defineQuery } from '../../platform/queries';
import {
  creditedAmountSql,
  outstandingOf,
  outstandingSql,
  paidAmountSql,
} from '../sales/settlement';
import { allocatedSql, loadReceiptDto, selectReceipts, toReceiptListItem } from './receipt-dto';

export const listReceipts = defineQuery({
  name: 'finance.receipts.list',
  description: 'List customer receipts, newest first, with allocated and unallocated amounts.',
  input: ListReceiptsQuery,
  permission: PERMISSIONS.receivablesRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId }, input): Promise<ReceiptListItemDto[]> => {
    let q = selectReceipts(db, companyId);
    if (input.customerId) q = q.where('r.customerId', '=', input.customerId);
    if (input.onlyUnallocated)
      q = q.where(sql<boolean>`${allocatedSql}::numeric < ${sql.ref('r.amount')}`);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('r.receiptNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
          eb('r.reference', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('r.receiptDate', 'desc')
      .orderBy('r.createdAt', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toReceiptListItem);
  },
});

export const getReceipt = defineQuery({
  name: 'finance.receipts.get',
  description: 'Get a customer receipt with its invoice allocations.',
  input: z.object({ receiptId: Uuid }),
  permission: PERMISSIONS.receivablesRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId }, input): Promise<ReceiptDto> =>
    loadReceiptDto(db, companyId, input.receiptId),
});

/** Issued invoices of a customer that still have money owed (after payments and credit notes), oldest first. */
export async function openInvoicesOf(
  db: DbExecutor,
  companyId: string,
  customerId: string | null,
  asOf: string,
): Promise<Array<OpenInvoiceDto & { customerId: string }>> {
  let q = db
    .selectFrom('sales.invoices as inv')
    .select(['inv.id', 'inv.customerId', 'inv.invoiceNumber', 'inv.invoiceDate', 'inv.grandTotal'])
    .select([paidAmountSql.as('paidAmount'), creditedAmountSql.as('creditedAmount')])
    .where('inv.companyId', '=', companyId)
    .where('inv.status', '=', 'ISSUED')
    .where(sql<boolean>`${outstandingSql} > 0`);
  if (customerId) q = q.where('inv.customerId', '=', customerId);
  const rows = await q.orderBy('inv.invoiceDate').orderBy('inv.invoiceNumber').execute();
  return rows.map((r) => ({
    invoiceId: r.id,
    customerId: r.customerId,
    invoiceNumber: r.invoiceNumber ?? '',
    invoiceDate: r.invoiceDate,
    grandTotal: r.grandTotal,
    paidAmount: r.paidAmount,
    creditedAmount: r.creditedAmount,
    outstandingAmount: outstandingOf(r.grandTotal, r.paidAmount, r.creditedAmount),
    ageDays: Math.max(0, daysBetween(r.invoiceDate, asOf)),
  }));
}

export const listOpenInvoices = defineQuery({
  name: 'finance.receivables.openInvoices',
  description: "A customer's issued invoices that still have an outstanding amount, oldest first.",
  input: OpenInvoicesQuery,
  permission: PERMISSIONS.receivablesRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId, now }, input): Promise<OpenInvoiceDto[]> =>
    (await openInvoicesOf(db, companyId, input.customerId, businessDate(now))).map(
      ({ customerId: _c, ...dto }) => dto,
    ),
});

import {
  PAYMENT_MODES,
  type PaymentMode,
  type ReceiptDto,
  type ReceiptListItemDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';
import { NotFoundError } from '../../platform/errors';

export const toPaymentMode = (m: string): PaymentMode =>
  PAYMENT_MODES.find((x) => x === m) ?? 'OTHER';

/** Σ allocations of the receipt aliased `r`. */
export const allocatedSql = sql<string>`(
  select coalesce(sum(a.amount), 0)::numeric(18,2)::text
    from finance.receipt_allocations a where a.receipt_id = ${sql.ref('r.id')})`;

export function selectReceipts(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('finance.receipts as r')
    .innerJoin('party.parties as p', 'p.id', 'r.customerId')
    .select([
      'r.id',
      'r.receiptNumber',
      'r.receiptDate',
      'r.customerId',
      'p.name as customerName',
      'r.paymentMode',
      'r.reference',
      'r.amount',
      'r.notes',
      'r.createdAt',
    ])
    .select(allocatedSql.as('allocatedAmount'))
    .where('r.companyId', '=', companyId);
}

type ReceiptRow = Awaited<ReturnType<ReturnType<typeof selectReceipts>['execute']>>[number];

export function toReceiptListItem(r: ReceiptRow): ReceiptListItemDto {
  return {
    id: r.id,
    receiptNumber: r.receiptNumber,
    receiptDate: r.receiptDate,
    customerId: r.customerId,
    customerName: r.customerName,
    paymentMode: toPaymentMode(r.paymentMode),
    reference: r.reference,
    amount: r.amount,
    allocatedAmount: r.allocatedAmount,
    // Derived, never stored.
    unallocatedAmount: Money.of(r.amount).minus(Money.of(r.allocatedAmount)).toString(),
  };
}

export async function loadReceiptDto(
  db: DbExecutor,
  companyId: string,
  receiptId: string,
): Promise<ReceiptDto> {
  const row = await selectReceipts(db, companyId)
    .leftJoin('identity.users as u', 'u.id', 'r.createdBy')
    .select('u.displayName as createdByName')
    .where('r.id', '=', receiptId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Receipt');

  const allocations = await db
    .selectFrom('finance.receiptAllocations as a')
    .innerJoin('sales.invoices as inv', 'inv.id', 'a.invoiceId')
    .leftJoin('identity.users as u', 'u.id', 'a.allocatedBy')
    .select([
      'a.id',
      'a.invoiceId',
      'inv.invoiceNumber',
      'inv.invoiceDate',
      'a.amount',
      'a.allocatedAt',
      'u.displayName as allocatedByName',
    ])
    .where('a.receiptId', '=', receiptId)
    .orderBy('a.allocatedAt')
    .orderBy('inv.invoiceDate')
    .execute();

  return {
    ...toReceiptListItem(row),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
    allocations: allocations.map((a) => ({
      id: a.id,
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoiceNumber ?? '',
      invoiceDate: a.invoiceDate,
      amount: a.amount,
      allocatedAt: a.allocatedAt.toISOString(),
      allocatedByName: a.allocatedByName,
    })),
  };
}

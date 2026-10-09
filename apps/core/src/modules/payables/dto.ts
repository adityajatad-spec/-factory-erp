import {
  PAYMENT_MODES,
  SUPPLIER_PAYMENT_STATUSES,
  type PaymentMode,
  type SupplierPaymentDto,
  type SupplierPaymentListItemDto,
  type SupplierPaymentStatus,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';
import { NotFoundError } from '../../platform/errors';

const toPaymentMode = (m: string): PaymentMode => PAYMENT_MODES.find((x) => x === m) ?? 'OTHER';
const toStatus = (s: string): SupplierPaymentStatus =>
  SUPPLIER_PAYMENT_STATUSES.find((x) => x === s) ?? 'PENDING_APPROVAL';

/** Σ allocations of the supplier payment aliased `sp`. */
export const allocatedSql = sql<string>`(
  select coalesce(sum(a.amount), 0)::numeric(18,2)::text
    from finance.supplier_payment_allocations a where a.payment_id = ${sql.ref('sp.id')})`;

export function selectSupplierPayments(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('finance.supplierPayments as sp')
    .innerJoin('party.parties as p', 'p.id', 'sp.supplierId')
    .innerJoin('identity.users as ur', 'ur.id', 'sp.requestedBy')
    .leftJoin('identity.users as ua', 'ua.id', 'sp.approvedBy')
    .select([
      'sp.id',
      'sp.status',
      'sp.paymentNumber',
      'sp.paymentDate',
      'sp.supplierId',
      'p.name as supplierName',
      'sp.amount',
      'sp.paymentMode',
      'sp.reference',
      'sp.requestedBy as requestedById',
      'ur.displayName as requestedByName',
      'ua.displayName as approvedByName',
      'sp.requestedAt',
    ])
    .select(allocatedSql.as('allocatedAmount'))
    .where('sp.companyId', '=', companyId);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectSupplierPayments>['execute']>>[number];

export function toSupplierPaymentListItem(r: Row): SupplierPaymentListItemDto {
  const status = toStatus(r.status);
  return {
    id: r.id,
    status,
    paymentNumber: r.paymentNumber,
    paymentDate: r.paymentDate,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    amount: r.amount,
    paymentMode: toPaymentMode(r.paymentMode),
    reference: r.reference,
    allocatedAmount: r.allocatedAmount,
    // Derived, never stored; only approved money can be on account.
    unallocatedAmount:
      status === 'APPROVED'
        ? Money.of(r.amount).minus(Money.of(r.allocatedAmount)).toString()
        : '0.00',
    requestedById: r.requestedById,
    requestedByName: r.requestedByName,
    approvedByName: r.approvedByName,
  };
}

interface ProposedAllocation {
  purchaseInvoiceId: string;
  amount: string;
}

export async function loadSupplierPaymentDto(
  db: DbExecutor,
  companyId: string,
  paymentId: string,
): Promise<SupplierPaymentDto> {
  const row = await selectSupplierPayments(db, companyId)
    .leftJoin('identity.users as uj', 'uj.id', 'sp.rejectedBy')
    .select([
      'sp.notes',
      'sp.proposedAllocations',
      'sp.approvedAt',
      'sp.rejectedAt',
      'uj.displayName as rejectedByName',
      'sp.rejectionReason',
      'sp.version',
    ])
    .where('sp.id', '=', paymentId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Supplier payment');

  const proposed = row.proposedAllocations as unknown as ProposedAllocation[];
  const proposedIds = proposed.map((a) => a.purchaseInvoiceId);
  const proposedBills = proposedIds.length
    ? await db
        .selectFrom('purchase.invoices')
        .select(['id', 'invoiceNumber', 'supplierInvoiceNumber'])
        .where('companyId', '=', companyId)
        .where('id', 'in', proposedIds)
        .execute()
    : [];
  const billById = new Map(proposedBills.map((b) => [b.id, b]));

  const allocations = await db
    .selectFrom('finance.supplierPaymentAllocations as a')
    .innerJoin('purchase.invoices as pi', 'pi.id', 'a.purchaseInvoiceId')
    .leftJoin('identity.users as u', 'u.id', 'a.allocatedBy')
    .select([
      'a.id',
      'a.purchaseInvoiceId',
      'pi.invoiceNumber',
      'pi.supplierInvoiceNumber',
      'a.amount',
      'a.allocatedAt',
      'u.displayName as allocatedByName',
    ])
    .where('a.paymentId', '=', paymentId)
    .orderBy('a.allocatedAt')
    .orderBy('pi.invoiceDate')
    .execute();

  return {
    ...toSupplierPaymentListItem(row),
    notes: row.notes,
    proposedAllocations: proposed.map((a) => ({
      purchaseInvoiceId: a.purchaseInvoiceId,
      invoiceNumber: billById.get(a.purchaseInvoiceId)?.invoiceNumber ?? null,
      supplierInvoiceNumber: billById.get(a.purchaseInvoiceId)?.supplierInvoiceNumber ?? '',
      amount: a.amount,
    })),
    allocations: allocations.map((a) => ({
      id: a.id,
      purchaseInvoiceId: a.purchaseInvoiceId,
      invoiceNumber: a.invoiceNumber ?? '',
      supplierInvoiceNumber: a.supplierInvoiceNumber,
      amount: a.amount,
      allocatedAt: a.allocatedAt.toISOString(),
      allocatedByName: a.allocatedByName,
    })),
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedByName: row.rejectedByName,
    rejectionReason: row.rejectionReason,
    version: row.version,
  };
}

import {
  CREDIT_NOTE_REASONS,
  INVOICE_STATUSES,
  PAYMENT_MODES,
  type InvoiceDto,
  type InvoiceListItemDto,
  type InvoiceStatus,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';
import { NotFoundError } from '../../platform/errors';
import { normalisePercent } from '../catalog';
import { creditedAmountSql, outstandingOf, paidAmountSql, paymentStatusOf } from './settlement';

const toStatus = (s: string): InvoiceStatus => INVOICE_STATUSES.find((x) => x === s) ?? 'DRAFT';
const toSupply = (s: string) =>
  s === 'INTER_STATE' ? ('INTER_STATE' as const) : ('INTRA_STATE' as const);

export function selectInvoiceList(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('sales.invoices as inv')
    .innerJoin('party.parties as p', 'p.id', 'inv.customerId')
    .select([
      'inv.id',
      'inv.status',
      'inv.invoiceNumber',
      'inv.invoiceDate',
      'inv.customerId',
      'p.name as customerName',
      'inv.supplyType',
      'inv.grandTotal',
      'inv.issuedAt',
      'inv.pdfDocumentId',
      'inv.createdAt',
    ])
    .select([paidAmountSql.as('paidAmount'), creditedAmountSql.as('creditedAmount')])
    .where('inv.companyId', '=', companyId);
}

/** Settlement fields shared by the list and detail DTOs (derived, never stored). */
function settlement(
  status: InvoiceStatus,
  r: { grandTotal: string; paidAmount: string; creditedAmount: string },
) {
  return {
    paymentStatus: paymentStatusOf(status, r.grandTotal, r.paidAmount, r.creditedAmount),
    paidAmount: r.paidAmount,
    creditedAmount: r.creditedAmount,
    outstandingAmount:
      status === 'ISSUED' ? outstandingOf(r.grandTotal, r.paidAmount, r.creditedAmount) : null,
  };
}

type ListRow = Awaited<ReturnType<ReturnType<typeof selectInvoiceList>['execute']>>[number];

export function toInvoiceListItem(r: ListRow): InvoiceListItemDto {
  const status = toStatus(r.status);
  return {
    id: r.id,
    status,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    customerId: r.customerId,
    customerName: r.customerName,
    supplyType: toSupply(r.supplyType),
    grandTotal: r.grandTotal,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    hasPdf: r.pdfDocumentId !== null,
    ...settlement(status, r),
  };
}

export async function loadInvoiceDto(
  db: DbExecutor,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  const h = await db
    .selectFrom('sales.invoices as inv')
    .innerJoin('party.parties as p', 'p.id', 'inv.customerId')
    .innerJoin('platform.states as s', 's.code', 'inv.placeOfSupplyStateCode')
    .leftJoin('identity.users as cu', 'cu.id', 'inv.cancelledBy')
    .selectAll('inv')
    .select([
      'p.name as customerName',
      'p.gstin as customerGstin',
      's.name as placeOfSupplyStateName',
      'cu.displayName as cancelledByName',
    ])
    .select([paidAmountSql.as('paidAmount'), creditedAmountSql.as('creditedAmount')])
    .where('inv.companyId', '=', companyId)
    .where('inv.id', '=', invoiceId)
    .executeTakeFirst();
  if (!h) throw new NotFoundError('Invoice');
  const status = toStatus(h.status);

  const payments = await db
    .selectFrom('finance.receiptAllocations as a')
    .innerJoin('finance.receipts as r', 'r.id', 'a.receiptId')
    .select([
      'a.id',
      'a.receiptId',
      'r.receiptNumber',
      'r.receiptDate',
      'r.paymentMode',
      'a.amount',
    ])
    .where('a.invoiceId', '=', invoiceId)
    .orderBy('r.receiptDate')
    .orderBy('a.allocatedAt')
    .execute();

  const creditNotes = await db
    .selectFrom('sales.creditNotes')
    .select(['id', 'creditNoteNumber', 'creditNoteDate', 'status', 'reasonCode', 'grandTotal'])
    .where('invoiceId', '=', invoiceId)
    .orderBy('creditNoteDate')
    .orderBy('createdAt')
    .execute();

  const lines = await db
    .selectFrom('sales.invoiceLines as l')
    .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
    .selectAll('l')
    .select('i.code as itemCode')
    // How much of each line issued credit notes have already credited.
    .select((eb) => [
      eb
        .selectFrom('sales.creditNoteLines as cl')
        .innerJoin('sales.creditNotes as cn', 'cn.id', 'cl.creditNoteId')
        .select(sql<string>`coalesce(sum(cl.quantity), 0)::numeric(18,3)::text`.as('q'))
        .whereRef('cl.invoiceId', '=', 'l.invoiceId')
        .whereRef('cl.invoiceLineNo', '=', 'l.lineNo')
        .where('cn.status', '=', 'ISSUED')
        .as('creditedQuantity'),
      eb
        .selectFrom('sales.creditNoteLines as cl')
        .innerJoin('sales.creditNotes as cn', 'cn.id', 'cl.creditNoteId')
        .select(sql<string>`coalesce(sum(cl.taxable_amount), 0)::numeric(18,2)::text`.as('t'))
        .whereRef('cl.invoiceId', '=', 'l.invoiceId')
        .whereRef('cl.invoiceLineNo', '=', 'l.lineNo')
        .where('cn.status', '=', 'ISSUED')
        .as('creditedTaxableAmount'),
    ])
    .where('l.invoiceId', '=', invoiceId)
    .orderBy('l.lineNo')
    .execute();

  // Issued invoices show the customer exactly as snapshotted at issue time.
  const snapshotName = (h.customerSnapshot as { name?: unknown } | null)?.name;
  const snapshotGstin = (h.customerSnapshot as { gstin?: unknown } | null)?.gstin;

  return {
    id: h.id,
    status,
    version: h.version,
    invoiceNumber: h.invoiceNumber,
    invoiceDate: h.invoiceDate,
    customerId: h.customerId,
    customerName: typeof snapshotName === 'string' ? snapshotName : h.customerName,
    customerGstin:
      typeof snapshotGstin === 'string' || snapshotGstin === null
        ? (snapshotGstin ?? null)
        : h.customerGstin,
    supplyType: toSupply(h.supplyType),
    supplierStateCode: h.supplierStateCode,
    invoiceRounding:
      (h.gstPolicy as { invoiceRounding?: unknown } | null)?.invoiceRounding === 'NONE'
        ? 'NONE'
        : 'NEAREST_RUPEE',
    placeOfSupplyStateCode: h.placeOfSupplyStateCode,
    placeOfSupplyStateName: h.placeOfSupplyStateName,
    notes: h.notes,
    grandTotal: h.grandTotal,
    totals: {
      grossAmount: h.grossAmount,
      discountAmount: h.discountAmount,
      taxableAmount: h.taxableAmount,
      cgstAmount: h.cgstAmount,
      sgstAmount: h.sgstAmount,
      igstAmount: h.igstAmount,
      totalTax: h.totalTax,
      roundOff: h.roundOff,
      grandTotal: h.grandTotal,
    },
    amountInWords: h.amountInWords,
    calcEngineVersion: h.calcEngineVersion,
    issuedAt: h.issuedAt?.toISOString() ?? null,
    pdfDocumentId: h.pdfDocumentId,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
    ...settlement(status, h),
    cancellation:
      h.cancelledAt && h.cancellationReason
        ? {
            cancelledAt: h.cancelledAt.toISOString(),
            cancelledByName: h.cancelledByName,
            reason: h.cancellationReason,
          }
        : null,
    creditNotes: creditNotes.map((c) => ({
      creditNoteId: c.id,
      creditNoteNumber: c.creditNoteNumber,
      creditNoteDate: c.creditNoteDate,
      status: c.status === 'ISSUED' ? ('ISSUED' as const) : ('DRAFT' as const),
      reasonCode: CREDIT_NOTE_REASONS.find((r) => r === c.reasonCode) ?? 'OTHER',
      grandTotal: c.grandTotal,
    })),
    payments: payments.map((p) => ({
      allocationId: p.id,
      receiptId: p.receiptId,
      receiptNumber: p.receiptNumber,
      receiptDate: p.receiptDate,
      paymentMode: PAYMENT_MODES.find((m) => m === p.paymentMode) ?? 'OTHER',
      amount: p.amount,
    })),
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      itemCode: l.itemCode,
      description: l.description,
      hsnCode: l.hsnCode,
      uom: l.uom,
      quantity: l.quantity,
      unitRate: l.unitRate,
      discountPercent: normalisePercent(l.discountPercent),
      gstRatePercent: normalisePercent(l.gstRatePercent),
      grossAmount: l.grossAmount,
      discountAmount: l.discountAmount,
      taxableAmount: l.taxableAmount,
      cgstRatePercent: normalisePercent(l.cgstRatePercent),
      cgstAmount: l.cgstAmount,
      sgstRatePercent: normalisePercent(l.sgstRatePercent),
      sgstAmount: l.sgstAmount,
      igstRatePercent: normalisePercent(l.igstRatePercent),
      igstAmount: l.igstAmount,
      lineTotal: l.lineTotal,
      creditedQuantity: l.creditedQuantity ?? '0.000',
      creditedTaxableAmount: l.creditedTaxableAmount ?? '0.00',
    })),
  };
}

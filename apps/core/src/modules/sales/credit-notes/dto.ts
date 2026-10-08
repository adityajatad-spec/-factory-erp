import {
  CREDIT_NOTE_REASONS,
  type CreditNoteDto,
  type CreditNoteListItemDto,
  type CreditNoteReason,
  type CreditNoteStatus,
} from '@factory-erp/contracts';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';
import { normalisePercent } from '../../catalog';

const toStatus = (s: string): CreditNoteStatus => (s === 'ISSUED' ? 'ISSUED' : 'DRAFT');
const toReason = (r: string): CreditNoteReason =>
  CREDIT_NOTE_REASONS.find((x) => x === r) ?? 'OTHER';

export function selectCreditNoteList(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('sales.creditNotes as cn')
    .innerJoin('party.parties as p', 'p.id', 'cn.customerId')
    .innerJoin('sales.invoices as inv', 'inv.id', 'cn.invoiceId')
    .select([
      'cn.id',
      'cn.status',
      'cn.creditNoteNumber',
      'cn.creditNoteDate',
      'cn.customerId',
      'p.name as customerName',
      'cn.invoiceId',
      'inv.invoiceNumber',
      'cn.reasonCode',
      'cn.grandTotal',
      'cn.issuedAt',
      'cn.pdfDocumentId',
      'cn.createdAt',
    ])
    .where('cn.companyId', '=', companyId);
}

type ListRow = Awaited<ReturnType<ReturnType<typeof selectCreditNoteList>['execute']>>[number];

export function toCreditNoteListItem(r: ListRow): CreditNoteListItemDto {
  return {
    id: r.id,
    status: toStatus(r.status),
    creditNoteNumber: r.creditNoteNumber,
    creditNoteDate: r.creditNoteDate,
    customerId: r.customerId,
    customerName: r.customerName,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber ?? '',
    reasonCode: toReason(r.reasonCode),
    grandTotal: r.grandTotal,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    hasPdf: r.pdfDocumentId !== null,
  };
}

export async function loadCreditNoteDto(
  db: DbExecutor,
  companyId: string,
  creditNoteId: string,
): Promise<CreditNoteDto> {
  const h = await db
    .selectFrom('sales.creditNotes as cn')
    .innerJoin('party.parties as p', 'p.id', 'cn.customerId')
    .innerJoin('sales.invoices as inv', 'inv.id', 'cn.invoiceId')
    .innerJoin('platform.states as s', 's.code', 'cn.placeOfSupplyStateCode')
    .selectAll('cn')
    .select([
      'p.name as customerName',
      'p.gstin as customerGstin',
      'inv.invoiceNumber',
      'inv.invoiceDate',
      's.name as placeOfSupplyStateName',
    ])
    .where('cn.companyId', '=', companyId)
    .where('cn.id', '=', creditNoteId)
    .executeTakeFirst();
  if (!h) throw new NotFoundError('Credit note');

  const lines = await db
    .selectFrom('sales.creditNoteLines as l')
    .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
    .selectAll('l')
    .select('i.code as itemCode')
    .where('l.creditNoteId', '=', creditNoteId)
    .orderBy('l.lineNo')
    .execute();

  // Issued credit notes show the customer exactly as snapshotted at issue time.
  const snap = h.customerSnapshot as { name?: unknown; gstin?: unknown } | null;

  return {
    id: h.id,
    status: toStatus(h.status),
    version: h.version,
    creditNoteNumber: h.creditNoteNumber,
    creditNoteDate: h.creditNoteDate,
    customerId: h.customerId,
    customerName: typeof snap?.name === 'string' ? snap.name : h.customerName,
    customerGstin:
      snap && (typeof snap.gstin === 'string' || snap.gstin === null)
        ? (snap.gstin ?? null)
        : h.customerGstin,
    invoiceId: h.invoiceId,
    invoiceNumber: h.invoiceNumber ?? '',
    invoiceDate: h.invoiceDate,
    reasonCode: toReason(h.reasonCode),
    reason: h.reason,
    notes: h.notes,
    supplyType: h.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    placeOfSupplyStateCode: h.placeOfSupplyStateCode,
    placeOfSupplyStateName: h.placeOfSupplyStateName,
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
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      invoiceLineNo: l.invoiceLineNo,
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
    })),
  };
}

import { CREDIT_NOTE_REASON_LABELS, CREDIT_NOTE_REASONS } from '@factory-erp/contracts';
import { Dec, Money } from '@factory-erp/money';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';
import { normalisePercent } from '../../catalog';
import { CustomerSnapshot, SellerSnapshot } from '../snapshots';

export interface PrintLine {
  lineNo: number;
  description: string;
  hsnCode: string;
  quantity: string;
  uom: string;
  unitRate: string;
  discountPercent: string;
  taxableAmount: string;
  gstRatePercent: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

/** Everything printed on an issued sales document (tax invoice or credit note). */
export interface SalesPrintModel {
  kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
  seller: SellerSnapshot;
  customer: CustomerSnapshot;
  documentNumber: string;
  documentDate: string;
  /** Credit notes only: the original invoice and why it is being credited. */
  creditNote: {
    againstInvoiceNumber: string;
    againstInvoiceDate: string;
    reasonLabel: string;
    reason: string;
  } | null;
  placeOfSupply: { code: string; name: string };
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  lines: PrintLine[];
  taxSummary: Array<{
    gstRatePercent: string;
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
  }>;
  totals: {
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    totalTax: string;
    roundOff: string;
    grandTotal: string;
  };
  amountInWords: string;
  notes: string | null;
  engineVersion: string;
  /** True until the company's finance readiness is PRODUCTION (Round 2 §7.3). */
  specimen: boolean;
  copyLabel: string;
}

interface StoredLine {
  lineNo: number;
  description: string;
  hsnCode: string;
  quantity: string;
  uom: string;
  unitRate: string;
  discountPercent: string;
  taxableAmount: string;
  gstRatePercent: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

const toPrintLine = (l: StoredLine): PrintLine => ({
  lineNo: l.lineNo,
  description: l.description,
  hsnCode: l.hsnCode,
  quantity: l.quantity,
  uom: l.uom,
  unitRate: l.unitRate,
  discountPercent: normalisePercent(l.discountPercent),
  taxableAmount: l.taxableAmount,
  gstRatePercent: normalisePercent(l.gstRatePercent),
  cgstAmount: l.cgstAmount,
  sgstAmount: l.sgstAmount,
  igstAmount: l.igstAmount,
  lineTotal: l.lineTotal,
});

/** Rate-wise tax summary from the stored (already computed) line values. */
function taxSummaryOf(lines: readonly StoredLine[]): SalesPrintModel['taxSummary'] {
  const groups = new Map<string, { taxable: Money; cgst: Money; sgst: Money; igst: Money }>();
  for (const l of lines) {
    const rate = normalisePercent(l.gstRatePercent);
    const g = groups.get(rate) ?? {
      taxable: Money.zero(),
      cgst: Money.zero(),
      sgst: Money.zero(),
      igst: Money.zero(),
    };
    groups.set(rate, {
      taxable: g.taxable.plus(Money.of(l.taxableAmount)),
      cgst: g.cgst.plus(Money.of(l.cgstAmount)),
      sgst: g.sgst.plus(Money.of(l.sgstAmount)),
      igst: g.igst.plus(Money.of(l.igstAmount)),
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => new Dec(a).comparedTo(new Dec(b)))
    .map(([rate, g]) => ({
      gstRatePercent: rate,
      taxableAmount: g.taxable.toString(),
      cgstAmount: g.cgst.toString(),
      sgstAmount: g.sgst.toString(),
      igstAmount: g.igst.toString(),
    }));
}

/** Build the print model from the ISSUED invoice's stored values and snapshots only. */
export async function buildInvoicePrintModel(
  db: DbExecutor,
  invoiceId: string,
): Promise<SalesPrintModel> {
  const inv = await db
    .selectFrom('sales.invoices as inv')
    .innerJoin('platform.states as s', 's.code', 'inv.placeOfSupplyStateCode')
    .selectAll('inv')
    .select('s.name as posName')
    .where('inv.id', '=', invoiceId)
    .executeTakeFirst();
  if (!inv?.invoiceNumber) throw new NotFoundError('Issued invoice');

  const seller = SellerSnapshot.parse(inv.sellerSnapshot);
  const lines = await db
    .selectFrom('sales.invoiceLines')
    .selectAll()
    .where('invoiceId', '=', invoiceId)
    .orderBy('lineNo')
    .execute();

  return {
    kind: 'TAX_INVOICE',
    seller,
    customer: CustomerSnapshot.parse(inv.customerSnapshot),
    documentNumber: inv.invoiceNumber,
    documentDate: inv.invoiceDate,
    creditNote: null,
    placeOfSupply: { code: inv.placeOfSupplyStateCode, name: inv.posName },
    supplyType: inv.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    lines: lines.map(toPrintLine),
    taxSummary: taxSummaryOf(lines),
    totals: {
      taxableAmount: inv.taxableAmount,
      cgstAmount: inv.cgstAmount,
      sgstAmount: inv.sgstAmount,
      igstAmount: inv.igstAmount,
      totalTax: inv.totalTax,
      roundOff: inv.roundOff,
      grandTotal: inv.grandTotal,
    },
    amountInWords: inv.amountInWords,
    notes: inv.notes,
    engineVersion: inv.calcEngineVersion,
    specimen: seller.financeReadiness !== 'PRODUCTION',
    // [VERIFY R-02] number and labelling of copies for goods.
    copyLabel: 'Original for Recipient',
  };
}

/** Build the print model from the ISSUED credit note's stored values and snapshots only. */
export async function buildCreditNotePrintModel(
  db: DbExecutor,
  creditNoteId: string,
): Promise<SalesPrintModel> {
  const cn = await db
    .selectFrom('sales.creditNotes as cn')
    .innerJoin('sales.invoices as inv', 'inv.id', 'cn.invoiceId')
    .innerJoin('platform.states as s', 's.code', 'cn.placeOfSupplyStateCode')
    .selectAll('cn')
    .select(['s.name as posName', 'inv.invoiceNumber', 'inv.invoiceDate'])
    .where('cn.id', '=', creditNoteId)
    .executeTakeFirst();
  if (!cn?.creditNoteNumber) throw new NotFoundError('Issued credit note');

  const seller = SellerSnapshot.parse(cn.sellerSnapshot);
  const lines = await db
    .selectFrom('sales.creditNoteLines')
    .selectAll()
    .where('creditNoteId', '=', creditNoteId)
    .orderBy('lineNo')
    .execute();
  const reason = CREDIT_NOTE_REASONS.find((r) => r === cn.reasonCode) ?? 'OTHER';

  return {
    kind: 'CREDIT_NOTE',
    seller,
    customer: CustomerSnapshot.parse(cn.customerSnapshot),
    documentNumber: cn.creditNoteNumber,
    documentDate: cn.creditNoteDate,
    creditNote: {
      againstInvoiceNumber: cn.invoiceNumber ?? '',
      againstInvoiceDate: cn.invoiceDate,
      reasonLabel: CREDIT_NOTE_REASON_LABELS[reason],
      reason: cn.reason,
    },
    placeOfSupply: { code: cn.placeOfSupplyStateCode, name: cn.posName },
    supplyType: cn.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    lines: lines.map(toPrintLine),
    taxSummary: taxSummaryOf(lines),
    totals: {
      taxableAmount: cn.taxableAmount,
      cgstAmount: cn.cgstAmount,
      sgstAmount: cn.sgstAmount,
      igstAmount: cn.igstAmount,
      totalTax: cn.totalTax,
      roundOff: cn.roundOff,
      grandTotal: cn.grandTotal,
    },
    amountInWords: cn.amountInWords,
    notes: cn.notes,
    engineVersion: cn.calcEngineVersion,
    specimen: seller.financeReadiness !== 'PRODUCTION',
    // [VERIFY R-03] particulars and copies required on a credit note.
    copyLabel: 'Original for Recipient',
  };
}

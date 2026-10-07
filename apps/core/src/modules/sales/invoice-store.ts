import type { InvoiceCalcResult } from '@factory-erp/gst';
import type { DbTransaction } from '../../db/database';
import { toJsonb } from '../../platform/json';
import type { PricedLine } from './pricing';

/** Header columns derived from a GST engine result. */
export function totalsColumns(calc: InvoiceCalcResult) {
  return {
    supplyType: calc.supplyType,
    grossAmount: calc.totals.grossAmount,
    discountAmount: calc.totals.discountAmount,
    taxableAmount: calc.totals.taxableAmount,
    cgstAmount: calc.totals.cgstAmount,
    sgstAmount: calc.totals.sgstAmount,
    igstAmount: calc.totals.igstAmount,
    totalTax: calc.totals.totalTax,
    roundOff: calc.totals.roundOff,
    grandTotal: calc.totals.grandTotal,
    amountInWords: calc.amountInWords,
    calcEngineVersion: calc.engineVersion,
    gstPolicy: toJsonb(calc.policy),
  };
}

/** Replace all lines of a DRAFT invoice (the SQL guard rejects this for issued invoices). */
export async function replaceInvoiceLines(
  tx: DbTransaction,
  invoiceId: string,
  lines: readonly PricedLine[],
): Promise<void> {
  await tx.deleteFrom('sales.invoiceLines').where('invoiceId', '=', invoiceId).execute();
  if (lines.length === 0) return;
  await tx
    .insertInto('sales.invoiceLines')
    .values(lines.map((l) => ({ ...l, invoiceId })))
    .execute();
}

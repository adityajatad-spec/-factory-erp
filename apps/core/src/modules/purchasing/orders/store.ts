import type { InvoiceCalcResult } from '@factory-erp/gst';
import type { DbTransaction } from '../../../db/database';
import { toJsonb } from '../../../platform/json';
import type { PricedLine } from '../../catalog';

/** Header columns derived from a GST engine result. */
export function orderTotals(calc: InvoiceCalcResult) {
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

/** Replace the lines of a DRAFT order (SQL refuses this once the order is approved). */
export async function replaceOrderLines(
  tx: DbTransaction,
  orderId: string,
  lines: readonly PricedLine[],
): Promise<void> {
  await tx.deleteFrom('purchase.orderLines').where('orderId', '=', orderId).execute();
  if (lines.length === 0) return;
  await tx
    .insertInto('purchase.orderLines')
    .values(
      lines.map((l) => ({
        orderId,
        lineNo: l.lineNo,
        itemId: l.itemId,
        description: l.description,
        hsnCode: l.hsnCode,
        uom: l.uom,
        quantity: l.quantity,
        unitRate: l.unitRate,
        discountPercent: l.discountPercent,
        gstRatePercent: l.gstRatePercent,
        grossAmount: l.grossAmount,
        discountAmount: l.discountAmount,
        taxableAmount: l.taxableAmount,
        cgstRatePercent: l.cgstRatePercent,
        cgstAmount: l.cgstAmount,
        sgstRatePercent: l.sgstRatePercent,
        sgstAmount: l.sgstAmount,
        igstRatePercent: l.igstRatePercent,
        igstAmount: l.igstAmount,
        lineTotal: l.lineTotal,
      })),
    )
    .execute();
}

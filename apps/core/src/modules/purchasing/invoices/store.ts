import type { DbTransaction } from '../../../db/database';
import type { PricedLine } from '../../catalog';

/**
 * The key that catches the same supplier bill entered twice: the printed number, upper-cased,
 * without spaces. Separators ("/", "-") are kept: removing them could make two genuinely
 * different numbers collide and block a real bill.
 */
export const supplierInvoiceKey = (supplierInvoiceNumber: string) =>
  supplierInvoiceNumber.toUpperCase().replace(/\s+/g, '');

export type InvoicePricedLine = PricedLine & { orderLineNo: number | null };

/** Replace the lines of a DRAFT purchase invoice (SQL refuses this once it is posted). */
export async function replaceInvoiceLines(
  tx: DbTransaction,
  invoiceId: string,
  orderId: string | null,
  lines: readonly InvoicePricedLine[],
): Promise<void> {
  await tx.deleteFrom('purchase.invoiceLines').where('invoiceId', '=', invoiceId).execute();
  if (lines.length === 0) return;
  await tx
    .insertInto('purchase.invoiceLines')
    .values(
      lines.map((l) => ({
        invoiceId,
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
        orderId: l.orderLineNo === null ? null : orderId,
        orderLineNo: l.orderLineNo,
      })),
    )
    .execute();
}

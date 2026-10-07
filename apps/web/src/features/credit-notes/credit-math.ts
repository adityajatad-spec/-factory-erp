import type { InvoiceDetailLineDto } from '@factory-erp/contracts';
import { calculateInvoice, GstCalculationError, type InvoiceCalcResult } from '@factory-erp/gst';
import { formatINR, isDecimalString, Money, parseDecimal } from '@factory-erp/money';

/** What the user typed for one invoice line (blank quantity = line not credited). */
export interface CreditInput {
  quantity: string;
  unitRate: string;
}

export interface CreditableInvoiceView {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  invoiceRounding: 'NEAREST_RUPEE' | 'NONE';
  outstandingAmount: string;
  lines: readonly InvoiceDetailLineDto[];
}

export interface CreditPreview {
  /** Lines that will be sent (non-blank quantity), in invoice-line order. */
  lines: Array<{ invoiceLineNo: number; quantity: string; unitRate: string }>;
  result: InvoiceCalcResult | null;
  /** Problems per invoice line number. */
  lineErrors: Map<number, string>;
  totalError: string | null;
  outstandingAfter: string | null;
}

const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const RATE = /^\d{1,14}(\.\d{1,4})?$/;
const gt = (a: string, b: string) => parseDecimal(a).gt(parseDecimal(b));

/**
 * Live PREVIEW of a credit note, mirroring the server's rules (same GST engine, the invoice's
 * supply type, line discounts, GST rates and rounding). Never authoritative: the server checks
 * everything again on save and once more, under lock, on issue.
 */
export function previewCreditNote(
  invoice: CreditableInvoiceView,
  inputs: ReadonlyMap<number, CreditInput>,
): CreditPreview {
  const lineErrors = new Map<number, string>();
  const chosen: Array<{ line: InvoiceDetailLineDto; quantity: string; unitRate: string }> = [];

  for (const line of invoice.lines) {
    const input = inputs.get(line.lineNo);
    const quantity = input?.quantity.trim() ?? '';
    const unitRate = input?.unitRate.trim() ?? '';
    if (quantity === '') continue;
    if (!QTY.test(quantity) || !/[1-9]/.test(quantity)) {
      lineErrors.set(line.lineNo, 'Enter a quantity greater than zero (max 3 decimals)');
    } else if (!RATE.test(unitRate)) {
      lineErrors.set(line.lineNo, 'Enter a rate (max 4 decimals)');
    } else if (gt(quantity, line.quantity)) {
      lineErrors.set(line.lineNo, `Only ${line.quantity} ${line.uom} were invoiced`);
    } else if (gt(unitRate, line.unitRate)) {
      lineErrors.set(line.lineNo, 'Rate is above the invoiced rate');
    }
    chosen.push({ line, quantity, unitRate });
  }

  const lines = chosen.map((c) => ({
    invoiceLineNo: c.line.lineNo,
    quantity: c.quantity,
    unitRate: c.unitRate,
  }));
  const empty = { lines, result: null, lineErrors, outstandingAfter: null };
  if (chosen.length === 0) return { ...empty, totalError: null };
  if (lineErrors.size > 0) return { ...empty, totalError: 'Fix the highlighted lines' };

  let result: InvoiceCalcResult;
  try {
    result = calculateInvoice({
      supplierStateCode: invoice.supplierStateCode,
      placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
      policy: { lineRounding: 'LINE_HALF_UP', invoiceRounding: invoice.invoiceRounding },
      lines: chosen.map((c, i) => ({
        lineNo: i + 1,
        quantity: c.quantity,
        unitRate: c.unitRate,
        discountPercent: c.line.discountPercent,
        gstRatePercent: c.line.gstRatePercent,
      })),
    });
  } catch (e) {
    if (e instanceof GstCalculationError)
      return { ...empty, totalError: e.issues[0]?.message ?? 'Invalid line' };
    throw e;
  }

  chosen.forEach((c, i) => {
    const taxable = result.lines[i]?.taxableAmount ?? '0';
    const left = Money.of(c.line.taxableAmount).minus(Money.of(c.line.creditedTaxableAmount));
    if (Money.of(taxable).isZero()) lineErrors.set(c.line.lineNo, 'This line credits nothing');
    else if (Money.of(taxable).compare(left) > 0)
      lineErrors.set(c.line.lineNo, `Only ${formatINR(left)} of this line is left to credit`);
  });

  const total = Money.of(result.totals.grandTotal);
  const outstanding = isDecimalString(invoice.outstandingAmount)
    ? Money.of(invoice.outstandingAmount)
    : Money.zero();
  let totalError: string | null = null;
  if (lineErrors.size > 0) totalError = 'Fix the highlighted lines';
  else if (!total.isPositive()) totalError = 'A credit note must be for more than ₹0.00';
  else if (total.compare(outstanding) > 0)
    totalError = `Only ${formatINR(outstanding)} is outstanding on this invoice`;

  return {
    lines,
    result,
    lineErrors,
    totalError,
    outstandingAfter: outstanding.minus(total).toString(),
  };
}

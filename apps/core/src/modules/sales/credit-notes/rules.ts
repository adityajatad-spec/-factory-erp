import { calculateInvoice, type GstPolicy, type InvoiceCalcResult } from '@factory-erp/gst';
import { formatINR, Money, Qty, Rate } from '@factory-erp/money';
import type { PricedLine } from '../pricing';
import { outstandingOf } from '../settlement';

/**
 * Credit-note rules — pure, no I/O. Used for drafts (early feedback) and again at issue, on
 * the invoice state read under the settlement lock.
 *
 * A credit note credits ONE issued invoice of the same customer. Each line credits one line of
 * that invoice: quantity × unit rate, with the invoice line's own discount % and GST rate,
 * priced by the same GST engine with the invoice's supply type and rounding policy.
 *
 *  1. The invoice must be ISSUED (not a draft, not cancelled) and belong to the customer.
 *  2. The credit note may not be dated before the invoice.
 *  3. Per line: quantity ≤ invoiced quantity, unit rate ≤ invoiced unit rate, and
 *     Σ credited taxable value (all issued credit notes + this one) ≤ invoiced taxable value.
 *  4. Its grand total must be positive and ≤ the invoice's outstanding amount
 *     (grand total − payments − earlier credit notes). Outstanding never goes negative: a
 *     credit after payment would need a refund or un-allocation, which are not modelled yet.
 * Requests are validated whole; nothing is capped or partially applied.
 */

export interface CreditableLine {
  lineNo: number;
  itemId: string;
  description: string;
  hsnCode: string;
  uom: string;
  quantity: string;
  unitRate: string;
  discountPercent: string;
  gstRatePercent: string;
  taxableAmount: string;
  /** Σ taxable value already credited on this line by ISSUED credit notes. */
  creditedTaxableAmount: string;
}

export interface CreditableInvoice {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  status: string;
  customerId: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  policy: GstPolicy;
  grandTotal: string;
  paidAmount: string;
  creditedAmount: string;
  lines: readonly CreditableLine[];
}

export interface CreditLineRequest {
  invoiceLineNo: number;
  quantity: string;
  unitRate: string;
}

export type CreditRule =
  | 'INVOICE_NOT_ISSUED'
  | 'CUSTOMER_MISMATCH'
  | 'CREDIT_NOTE_BEFORE_INVOICE'
  | 'INVOICE_LINE_NOT_FOUND'
  | 'DUPLICATE_INVOICE_LINE'
  | 'EXCEEDS_LINE_QUANTITY'
  | 'EXCEEDS_LINE_RATE'
  | 'EXCEEDS_LINE_CREDITABLE'
  | 'CREDIT_NOTE_ZERO'
  | 'EXCEEDS_INVOICE_OUTSTANDING';

export interface CreditIssue {
  path: string;
  rule: CreditRule;
  message: string;
}

export interface PricedCreditLine extends PricedLine {
  invoiceLineNo: number;
}

export interface CreditAssessment {
  issues: CreditIssue[];
  /** Present when the request could be priced (no structural issues). */
  calc?: InvoiceCalcResult;
  lines?: PricedCreditLine[];
}

const label = (inv: CreditableInvoice) => inv.invoiceNumber ?? 'the draft invoice';

export function assessCreditNote(args: {
  invoice: CreditableInvoice;
  customerId: string;
  creditNoteDate: string;
  lines: readonly CreditLineRequest[];
}): CreditAssessment {
  const { invoice: inv } = args;
  const issues: CreditIssue[] = [];

  if (inv.status !== 'ISSUED') {
    issues.push({
      path: 'invoiceId',
      rule: 'INVOICE_NOT_ISSUED',
      message: `${label(inv)} is ${inv.status}; only issued invoices can be credited`,
    });
    return { issues };
  }
  if (inv.customerId !== args.customerId) {
    issues.push({
      path: 'customerId',
      rule: 'CUSTOMER_MISMATCH',
      message: `${label(inv)} belongs to a different customer`,
    });
    return { issues };
  }
  if (args.creditNoteDate < inv.invoiceDate) {
    issues.push({
      path: 'creditNoteDate',
      rule: 'CREDIT_NOTE_BEFORE_INVOICE',
      message: `A credit note cannot be dated before ${label(inv)} (${inv.invoiceDate})`,
    });
  }

  const byNo = new Map(inv.lines.map((l) => [l.lineNo, l]));
  const seen = new Set<number>();
  const matched: Array<{ req: CreditLineRequest; line: CreditableLine; path: string }> = [];
  args.lines.forEach((req, i) => {
    const path = `lines.${i}`;
    if (seen.has(req.invoiceLineNo)) {
      issues.push({ path, rule: 'DUPLICATE_INVOICE_LINE', message: 'Line credited twice' });
      return;
    }
    seen.add(req.invoiceLineNo);
    const line = byNo.get(req.invoiceLineNo);
    if (!line) {
      issues.push({
        path: `${path}.invoiceLineNo`,
        rule: 'INVOICE_LINE_NOT_FOUND',
        message: `${label(inv)} has no line ${req.invoiceLineNo}`,
      });
      return;
    }
    if (Qty.of(req.quantity).toDecimal().gt(Qty.of(line.quantity).toDecimal())) {
      issues.push({
        path: `${path}.quantity`,
        rule: 'EXCEEDS_LINE_QUANTITY',
        message: `Line ${line.lineNo}: cannot credit ${req.quantity} ${line.uom}; only ${line.quantity} were invoiced`,
      });
    }
    if (Rate.of(req.unitRate).toDecimal().gt(Rate.of(line.unitRate).toDecimal())) {
      issues.push({
        path: `${path}.unitRate`,
        rule: 'EXCEEDS_LINE_RATE',
        message: `Line ${line.lineNo}: the credit rate ${req.unitRate} is above the invoiced rate ${line.unitRate}`,
      });
    }
    matched.push({ req, line, path });
  });
  if (issues.length) return { issues };

  // Same engine, same supply type and rounding policy as the invoice. Malformed input raises
  // GstCalculationError, which callers report as a validation error (as for invoices).
  const calc: InvoiceCalcResult = calculateInvoice({
    supplierStateCode: inv.supplierStateCode,
    placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
    policy: inv.policy,
    lines: matched.map(({ req, line }, i) => ({
      lineNo: i + 1,
      quantity: req.quantity,
      unitRate: req.unitRate,
      discountPercent: line.discountPercent,
      gstRatePercent: line.gstRatePercent,
    })),
  });

  const lines = matched.map(({ line }, i): PricedCreditLine => {
    const c = calc.lines[i];
    if (!c) throw new Error(`GST engine returned no result for credit line ${i + 1}`);
    return {
      lineNo: i + 1,
      invoiceLineNo: line.lineNo,
      itemId: line.itemId,
      description: line.description,
      hsnCode: line.hsnCode,
      uom: line.uom,
      quantity: c.quantity,
      unitRate: c.unitRate,
      discountPercent: c.discountPercent,
      gstRatePercent: c.gstRatePercent,
      grossAmount: c.grossAmount,
      discountAmount: c.discountAmount,
      taxableAmount: c.taxableAmount,
      cgstRatePercent: c.cgstRatePercent,
      cgstAmount: c.cgstAmount,
      sgstRatePercent: c.sgstRatePercent,
      sgstAmount: c.sgstAmount,
      igstRatePercent: c.igstRatePercent,
      igstAmount: c.igstAmount,
      lineTotal: c.lineTotal,
    };
  });

  lines.forEach((l, i) => {
    const original = matched[i]?.line;
    if (!original) return;
    const creditable = Money.of(original.taxableAmount).minus(
      Money.of(original.creditedTaxableAmount),
    );
    if (Money.of(l.taxableAmount).isZero()) {
      issues.push({
        path: `${matched[i]?.path ?? `lines.${i}`}.unitRate`,
        rule: 'CREDIT_NOTE_ZERO',
        message: `Line ${original.lineNo}: credits nothing (₹0.00 taxable value)`,
      });
    } else if (Money.of(l.taxableAmount).compare(creditable) > 0) {
      issues.push({
        path: `${matched[i]?.path ?? `lines.${i}`}`,
        rule: 'EXCEEDS_LINE_CREDITABLE',
        message: `Line ${original.lineNo}: only ${formatINR(creditable)} of its taxable value is left to credit; this credits ${formatINR(Money.of(l.taxableAmount))}`,
      });
    }
  });

  const total = Money.of(calc.totals.grandTotal);
  const outstanding = Money.of(outstandingOf(inv.grandTotal, inv.paidAmount, inv.creditedAmount));
  if (!total.isPositive()) {
    issues.push({
      path: 'lines',
      rule: 'CREDIT_NOTE_ZERO',
      message: 'A credit note must be for more than ₹0.00',
    });
  } else if (total.compare(outstanding) > 0) {
    issues.push({
      path: 'lines',
      rule: 'EXCEEDS_INVOICE_OUTSTANDING',
      message: `${label(inv)} has only ${formatINR(outstanding)} outstanding; a credit note of ${formatINR(total)} would make it negative`,
    });
  }

  return { issues, calc, lines };
}

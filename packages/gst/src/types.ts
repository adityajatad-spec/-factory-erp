/**
 * Public types of the GST engine. All amounts are exact decimal strings; the engine never
 * accepts or returns JavaScript numbers for money, quantities or rates.
 */

export type SupplyType = 'INTRA_STATE' | 'INTER_STATE';

/**
 * Rounding/computation policy. Every option here is a **CA validation point**
 * (docs/ARCHITECTURE.md, Round 2 §7) — defaults are engineering defaults, not
 * confirmed accounting policy.
 */
export interface GstPolicy {
  /**
   * How each line amount and tax component is rounded to paise.
   * Only line-level HALF_UP is implemented; rate-wise summation is a known alternative that
   * needs a CA decision before it is built.
   */
  lineRounding: 'LINE_HALF_UP';
  /** Grand-total rounding. NEAREST_RUPEE adds an explicit round-off line. */
  invoiceRounding: 'NEAREST_RUPEE' | 'NONE';
}

export const DEFAULT_GST_POLICY: GstPolicy = {
  lineRounding: 'LINE_HALF_UP',
  invoiceRounding: 'NEAREST_RUPEE',
};

export interface LineInput {
  lineNo: number;
  /** Max 3 decimal places. Must be > 0. */
  quantity: string;
  /** Unit price, max 4 decimal places. Must be >= 0. */
  unitRate: string;
  /** Line discount percentage 0..100. */
  discountPercent: string;
  /** Total GST rate for the line (e.g. "18"); split into CGST/SGST or applied as IGST. */
  gstRatePercent: string;
}

export interface InvoiceCalcInput {
  /** 2-digit GST state code of the supplier (from the company GSTIN/registration). */
  supplierStateCode: string;
  /** 2-digit GST state code of the place of supply. */
  placeOfSupplyStateCode: string;
  lines: readonly LineInput[];
  policy: GstPolicy;
}

export interface LineResult {
  lineNo: number;
  quantity: string;
  unitRate: string;
  grossAmount: string;
  discountPercent: string;
  discountAmount: string;
  taxableAmount: string;
  gstRatePercent: string;
  cgstRatePercent: string;
  cgstAmount: string;
  sgstRatePercent: string;
  sgstAmount: string;
  igstRatePercent: string;
  igstAmount: string;
  lineTotal: string;
}

export interface TaxSummaryRow {
  gstRatePercent: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
}

export interface InvoiceTotals {
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
  totalBeforeRounding: string;
  roundOff: string;
  grandTotal: string;
}

export interface InvoiceCalcResult {
  engineVersion: string;
  policy: GstPolicy;
  supplyType: SupplyType;
  lines: LineResult[];
  taxSummary: TaxSummaryRow[];
  totals: InvoiceTotals;
  amountInWords: string;
}

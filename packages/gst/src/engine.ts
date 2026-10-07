import { amountInWordsINR, Dec, Money, Percent, Qty, Rate } from '@factory-erp/money';
import { GstCalculationError, type GstIssue } from './errors';
import type {
  InvoiceCalcInput,
  InvoiceCalcResult,
  LineInput,
  LineResult,
  SupplyType,
  TaxSummaryRow,
} from './types';

/**
 * Bump on ANY change that can alter an output for the same input. Issued invoices store
 * the version they were computed with and are never recomputed.
 */
export const GST_ENGINE_VERSION = '1.0.0';

const STATE_CODE = /^\d{2}$/;
const MAX_LINES = 500;

interface ParsedLine {
  lineNo: number;
  quantity: Qty;
  unitRate: Rate;
  discount: Percent;
  gstRate: Percent;
}

function parseLine(line: LineInput, index: number, issues: GstIssue[]): ParsedLine | null {
  const at = (field: string) => `lines[${index}].${field}`;
  const before = issues.length;

  if (!Number.isInteger(line.lineNo) || line.lineNo < 1) {
    issues.push({ path: at('lineNo'), message: 'must be a positive integer' });
  }

  const tryParse = <T>(field: string, parse: () => T): T | null => {
    try {
      return parse();
    } catch (e) {
      issues.push({ path: at(field), message: e instanceof Error ? e.message : 'invalid' });
      return null;
    }
  };

  const quantity = tryParse('quantity', () => Qty.of(line.quantity));
  const unitRate = tryParse('unitRate', () => Rate.of(line.unitRate));
  const discount = tryParse('discountPercent', () => Percent.of(line.discountPercent));
  const gstRate = tryParse('gstRatePercent', () => Percent.of(line.gstRatePercent));

  if (quantity && !quantity.isPositive()) {
    issues.push({ path: at('quantity'), message: 'must be greater than zero' });
  }
  if (unitRate?.isNegative()) {
    issues.push({ path: at('unitRate'), message: 'must not be negative' });
  }

  if (issues.length > before || !quantity || !unitRate || !discount || !gstRate) return null;
  return { lineNo: line.lineNo, quantity, unitRate, discount, gstRate };
}

function validate(input: InvoiceCalcInput): ParsedLine[] {
  const issues: GstIssue[] = [];

  if (!STATE_CODE.test(input.supplierStateCode)) {
    issues.push({ path: 'supplierStateCode', message: 'must be a 2-digit state code' });
  }
  if (!STATE_CODE.test(input.placeOfSupplyStateCode)) {
    issues.push({ path: 'placeOfSupplyStateCode', message: 'must be a 2-digit state code' });
  }
  if (input.lines.length === 0) {
    issues.push({ path: 'lines', message: 'at least one line is required' });
  }
  if (input.lines.length > MAX_LINES) {
    issues.push({ path: 'lines', message: `at most ${MAX_LINES} lines are allowed` });
  }

  const seen = new Set<number>();
  const parsed: ParsedLine[] = [];
  input.lines.forEach((line, index) => {
    if (seen.has(line.lineNo)) {
      issues.push({ path: `lines[${index}].lineNo`, message: 'duplicate line number' });
    }
    seen.add(line.lineNo);
    const p = parseLine(line, index, issues);
    if (p) parsed.push(p);
  });

  if (issues.length > 0) throw new GstCalculationError(issues);
  return parsed;
}

function calculateLine(line: ParsedLine, supplyType: SupplyType): LineResult {
  // Policy LINE_HALF_UP: each monetary step is rounded to paise, half-up. [CA validation point]
  const gross = Money.round(line.quantity.toDecimal().times(line.unitRate.toDecimal()), 'HALF_UP');
  const discountAmount = Money.round(line.discount.applyTo(gross.toDecimal()), 'HALF_UP');
  const taxable = gross.minus(discountAmount);

  const zero = Percent.of('0');
  let cgstRate = zero;
  let sgstRate = zero;
  let igstRate = zero;
  if (supplyType === 'INTRA_STATE') {
    cgstRate = line.gstRate.half();
    sgstRate = line.gstRate.half();
  } else {
    igstRate = line.gstRate;
  }

  // CGST and SGST are computed from the same half-rate, so they are always equal.
  const cgst = Money.round(cgstRate.applyTo(taxable.toDecimal()), 'HALF_UP');
  const sgst = Money.round(sgstRate.applyTo(taxable.toDecimal()), 'HALF_UP');
  const igst = Money.round(igstRate.applyTo(taxable.toDecimal()), 'HALF_UP');

  return {
    lineNo: line.lineNo,
    quantity: line.quantity.toString(),
    unitRate: line.unitRate.toString(),
    grossAmount: gross.toString(),
    discountPercent: line.discount.toString(),
    discountAmount: discountAmount.toString(),
    taxableAmount: taxable.toString(),
    gstRatePercent: line.gstRate.toString(),
    cgstRatePercent: cgstRate.toString(),
    cgstAmount: cgst.toString(),
    sgstRatePercent: sgstRate.toString(),
    sgstAmount: sgst.toString(),
    igstRatePercent: igstRate.toString(),
    igstAmount: igst.toString(),
    lineTotal: taxable.plus(cgst).plus(sgst).plus(igst).toString(),
  };
}

function summarise(lines: readonly LineResult[]): TaxSummaryRow[] {
  const byRate = new Map<string, LineResult[]>();
  for (const line of lines) {
    const group = byRate.get(line.gstRatePercent) ?? [];
    group.push(line);
    byRate.set(line.gstRatePercent, group);
  }

  const sum = (rows: readonly LineResult[], pick: (l: LineResult) => string) =>
    Money.sum(rows.map((r) => Money.of(pick(r))));

  return [...byRate.entries()]
    .sort(([a], [b]) => new Dec(a).comparedTo(new Dec(b)))
    .map(([rate, rows]) => {
      const cgst = sum(rows, (r) => r.cgstAmount);
      const sgst = sum(rows, (r) => r.sgstAmount);
      const igst = sum(rows, (r) => r.igstAmount);
      return {
        gstRatePercent: rate,
        taxableAmount: sum(rows, (r) => r.taxableAmount).toString(),
        cgstAmount: cgst.toString(),
        sgstAmount: sgst.toString(),
        igstAmount: igst.toString(),
        totalTax: cgst.plus(sgst).plus(igst).toString(),
      };
    });
}

export function determineSupplyType(
  supplierStateCode: string,
  placeOfSupplyStateCode: string,
): SupplyType {
  // SEZ, export and other special cases are not modelled yet [VERIFY R-05].
  return supplierStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE';
}

/**
 * Calculate a GST invoice. Pure and deterministic: the same input always yields the same
 * output, and nothing here performs I/O or reads the clock.
 */
export function calculateInvoice(input: InvoiceCalcInput): InvoiceCalcResult {
  const parsed = validate(input);
  const supplyType = determineSupplyType(input.supplierStateCode, input.placeOfSupplyStateCode);

  const lines = [...parsed]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => calculateLine(l, supplyType));

  const total = (pick: (l: LineResult) => string) => Money.sum(lines.map((l) => Money.of(pick(l))));
  const gross = total((l) => l.grossAmount);
  const discount = total((l) => l.discountAmount);
  const taxable = total((l) => l.taxableAmount);
  const cgst = total((l) => l.cgstAmount);
  const sgst = total((l) => l.sgstAmount);
  const igst = total((l) => l.igstAmount);
  const totalTax = cgst.plus(sgst).plus(igst);
  const beforeRounding = taxable.plus(totalTax);

  // [CA validation point] Whole-rupee rounding of the grand total, half-up.
  const grandTotal =
    input.policy.invoiceRounding === 'NEAREST_RUPEE'
      ? beforeRounding.roundToRupee('HALF_UP')
      : beforeRounding;
  const roundOff = grandTotal.minus(beforeRounding);

  return {
    engineVersion: GST_ENGINE_VERSION,
    policy: { ...input.policy },
    supplyType,
    lines,
    taxSummary: summarise(lines),
    totals: {
      grossAmount: gross.toString(),
      discountAmount: discount.toString(),
      taxableAmount: taxable.toString(),
      cgstAmount: cgst.toString(),
      sgstAmount: sgst.toString(),
      igstAmount: igst.toString(),
      totalTax: totalTax.toString(),
      totalBeforeRounding: beforeRounding.toString(),
      roundOff: roundOff.toString(),
      grandTotal: grandTotal.toString(),
    },
    amountInWords: amountInWordsINR(grandTotal),
  };
}

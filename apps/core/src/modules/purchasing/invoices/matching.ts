import type { MatchFinding } from '@factory-erp/contracts';
import { Dec, Money, Percent, Qty, Rate } from '@factory-erp/money';

/**
 * Three-way match — pure, deterministic, no I/O and no AI.
 *
 * Compares a purchase invoice with its purchase order (what we agreed) and the goods received
 * against that order (what actually arrived and was accepted). Findings are facts for a human
 * to review; none of them is decided here.
 *
 * RULES (tolerances are company data, defaulting to none, for the CA to set):
 *  1. NOT_ON_ORDER — an invoice line that bills no line of the order (e.g. freight).
 *  2. ITEM_MISMATCH — the invoice line's item differs from the order line it bills.
 *  3. QTY_EXCEEDS_RECEIVED — Σ billed for an order line (earlier posted invoices + this one)
 *     is more than the accepted quantity received, plus the quantity tolerance %.
 *     Matching is against everything received on the order, so one bill may cover several
 *     deliveries and one delivery several bills.
 *  4. PRICE_ABOVE_ORDER — the billed net unit price (rate less discount) is above the
 *     order's net unit price, plus the price tolerance %. A lower price is not a finding.
 *  5. TOTAL_MISMATCH — the total on the supplier's bill differs from the total we compute
 *     (with the shared GST engine) by more than the total tolerance (₹). This also applies
 *     to direct (non-PO) invoices, the only check they get.
 *
 * The supplier itself always matches: the database refuses an invoice whose order belongs to
 * another supplier.
 */

export interface MatchTolerances {
  qtyPercent: string;
  pricePercent: string;
  totalAmount: string;
}

export interface MatchOrderLine {
  lineNo: number;
  itemId: string;
  itemCode: string;
  unitRate: string;
  discountPercent: string;
  /** Accepted into stock across all goods receipts of the order. */
  acceptedQuantity: string;
  /** Billed on other, already posted invoices. */
  invoicedQuantity: string;
}

export interface MatchInvoiceLine {
  lineNo: number;
  itemId: string;
  itemCode: string;
  orderLineNo: number | null;
  quantity: string;
  unitRate: string;
  discountPercent: string;
}

/** Net price of one unit after the line discount, unrounded. */
const netUnitPrice = (rate: string, discountPercent: string) => {
  const r = Rate.of(rate).toDecimal();
  return r.minus(Percent.of(discountPercent).applyTo(r));
};

/** value × (1 + percent / 100), unrounded. */
const withTolerance = (value: Dec, percent: string) =>
  value.plus(Percent.of(percent).applyTo(value));

const fmtQty = (d: Dec) => Qty.of(d.toDecimalPlaces(3).toString()).toString();
const fmtPrice = (d: Dec) => d.toDecimalPlaces(4).toFixed(4);

export function threeWayMatch(args: {
  tolerances: MatchTolerances;
  /** Null for a direct (non-PO) invoice: only the total is checked. */
  order: { lines: readonly MatchOrderLine[] } | null;
  lines: readonly MatchInvoiceLine[];
  computedTotal: string;
  supplierStatedTotal: string;
}): MatchFinding[] {
  const findings: MatchFinding[] = [];
  const t = args.tolerances;

  if (args.order) {
    const orderLines = new Map(args.order.lines.map((l) => [l.lineNo, l]));
    for (const line of args.lines) {
      if (line.orderLineNo === null) {
        findings.push({
          code: 'NOT_ON_ORDER',
          invoiceLineNo: line.lineNo,
          orderLineNo: null,
          message: `Line ${line.lineNo} (${line.itemCode}) is not on the purchase order`,
          expected: null,
          actual: line.quantity,
        });
        continue;
      }
      const ol = orderLines.get(line.orderLineNo);
      if (!ol) {
        // The command validates order lines before matching; this keeps the function total.
        findings.push({
          code: 'NOT_ON_ORDER',
          invoiceLineNo: line.lineNo,
          orderLineNo: line.orderLineNo,
          message: `Line ${line.lineNo} bills order line ${line.orderLineNo}, which does not exist`,
          expected: null,
          actual: line.quantity,
        });
        continue;
      }
      if (ol.itemId !== line.itemId) {
        findings.push({
          code: 'ITEM_MISMATCH',
          invoiceLineNo: line.lineNo,
          orderLineNo: ol.lineNo,
          message: `Line ${line.lineNo} bills ${line.itemCode}, but order line ${ol.lineNo} is for ${ol.itemCode}`,
          expected: ol.itemCode,
          actual: line.itemCode,
        });
        // Quantities and prices of different items are not comparable.
        continue;
      }

      const billed = Qty.of(ol.invoicedQuantity)
        .toDecimal()
        .plus(Qty.of(line.quantity).toDecimal());
      const allowed = withTolerance(Qty.of(ol.acceptedQuantity).toDecimal(), t.qtyPercent);
      if (billed.greaterThan(allowed)) {
        findings.push({
          code: 'QTY_EXCEEDS_RECEIVED',
          invoiceLineNo: line.lineNo,
          orderLineNo: ol.lineNo,
          message: `Line ${line.lineNo} (${line.itemCode}): ${fmtQty(billed)} billed in total, but only ${Qty.of(ol.acceptedQuantity).toString()} accepted`,
          expected: Qty.of(ol.acceptedQuantity).toString(),
          actual: fmtQty(billed),
        });
      }

      const billedPrice = netUnitPrice(line.unitRate, line.discountPercent);
      const orderPrice = netUnitPrice(ol.unitRate, ol.discountPercent);
      if (billedPrice.greaterThan(withTolerance(orderPrice, t.pricePercent))) {
        findings.push({
          code: 'PRICE_ABOVE_ORDER',
          invoiceLineNo: line.lineNo,
          orderLineNo: ol.lineNo,
          message: `Line ${line.lineNo} (${line.itemCode}): net price ₹${fmtPrice(billedPrice)} is above the ordered ₹${fmtPrice(orderPrice)}`,
          expected: fmtPrice(orderPrice),
          actual: fmtPrice(billedPrice),
        });
      }
    }
  }

  const computed = Money.of(args.computedTotal);
  const stated = Money.of(args.supplierStatedTotal);
  const diff = computed.minus(stated).toDecimal().abs();
  if (diff.greaterThan(Money.of(t.totalAmount).toDecimal())) {
    findings.push({
      code: 'TOTAL_MISMATCH',
      invoiceLineNo: null,
      orderLineNo: null,
      message: `The supplier's total ₹${stated.toString()} differs from the computed ₹${computed.toString()} by ₹${new Dec(diff).toFixed(2)}`,
      expected: computed.toString(),
      actual: stated.toString(),
    });
  }
  return findings;
}

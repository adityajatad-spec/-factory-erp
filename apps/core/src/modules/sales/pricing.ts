import {
  calculateInvoice,
  GstCalculationError,
  type GstPolicy,
  type InvoiceCalcResult,
} from '@factory-erp/gst';
import type { DbTransaction } from '../../db/database';
import { BusinessRuleError, ValidationError } from '../../platform/errors';
import { findEffectiveGstRates } from '../catalog/gst-rates';
import { SALEABLE_TYPES } from '../catalog/item-dto';

export interface DraftLine {
  itemId: string;
  description: string | null;
  quantity: string;
  unitRate: string;
  discountPercent: string;
}

export interface PricedLine {
  lineNo: number;
  itemId: string;
  description: string;
  hsnCode: string;
  uom: string;
  quantity: string;
  unitRate: string;
  discountPercent: string;
  gstRatePercent: string;
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstRatePercent: string;
  cgstAmount: string;
  sgstRatePercent: string;
  sgstAmount: string;
  igstRatePercent: string;
  igstAmount: string;
  lineTotal: string;
}

export function policyFromCompany(invoiceRounding: string): GstPolicy {
  return {
    lineRounding: 'LINE_HALF_UP',
    invoiceRounding: invoiceRounding === 'NONE' ? 'NONE' : 'NEAREST_RUPEE',
  };
}

/**
 * Authoritative server-side pricing. Item details and GST rates are read from the database
 * (rates in force on the invoice date); the client's own totals are never used.
 */
export async function priceInvoice(
  tx: DbTransaction,
  args: {
    companyId: string;
    invoiceDate: string;
    supplierStateCode: string;
    placeOfSupplyStateCode: string;
    policy: GstPolicy;
    lines: readonly DraftLine[];
  },
): Promise<{ calc: InvoiceCalcResult; lines: PricedLine[] }> {
  const itemIds = [...new Set(args.lines.map((l) => l.itemId))];
  const items = await tx
    .selectFrom('catalog.items')
    .select(['id', 'name', 'hsnCode', 'uom', 'itemType', 'status'])
    .where('companyId', '=', args.companyId)
    .where('id', 'in', itemIds)
    .execute();
  const byId = new Map(items.map((i) => [i.id, i]));

  const issues: Array<{ path: string; message: string }> = [];
  args.lines.forEach((l, i) => {
    const item = byId.get(l.itemId);
    if (!item) issues.push({ path: `lines.${i}.itemId`, message: 'Item not found' });
    else if (item.status !== 'ACTIVE')
      issues.push({ path: `lines.${i}.itemId`, message: `${item.name} is archived` });
    else if (!(SALEABLE_TYPES as readonly string[]).includes(item.itemType)) {
      issues.push({ path: `lines.${i}.itemId`, message: `${item.name} is not a saleable item` });
    }
  });
  if (issues.length) throw new ValidationError(issues, 'Some invoice lines are invalid');

  const rates = await findEffectiveGstRates(
    tx,
    items.map((i) => i.hsnCode),
    args.invoiceDate,
  );

  const resolved = args.lines.map((l, i) => {
    const item = byId.get(l.itemId);
    if (!item) throw new Error('unreachable: item checked above');
    const rate = rates.get(item.hsnCode);
    if (!rate) {
      throw new BusinessRuleError(
        'NO_GST_RATE',
        `No GST rate is configured for HSN ${item.hsnCode} (${item.name}) on ${args.invoiceDate}`,
      );
    }
    return { lineNo: i + 1, line: l, item, gstRatePercent: rate.ratePercent };
  });

  let calc: InvoiceCalcResult;
  try {
    calc = calculateInvoice({
      supplierStateCode: args.supplierStateCode,
      placeOfSupplyStateCode: args.placeOfSupplyStateCode,
      policy: args.policy,
      lines: resolved.map((r) => ({
        lineNo: r.lineNo,
        quantity: r.line.quantity,
        unitRate: r.line.unitRate,
        discountPercent: r.line.discountPercent,
        gstRatePercent: r.gstRatePercent,
      })),
    });
  } catch (e) {
    if (e instanceof GstCalculationError)
      throw new ValidationError(e.issues, 'Invoice could not be calculated');
    throw e;
  }

  const lines = resolved.map((r): PricedLine => {
    const c = calc.lines.find((x) => x.lineNo === r.lineNo);
    if (!c) throw new Error(`GST engine returned no result for line ${r.lineNo}`);
    return {
      lineNo: r.lineNo,
      itemId: r.item.id,
      description: r.line.description ?? r.item.name,
      hsnCode: r.item.hsnCode,
      uom: r.item.uom,
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

  return { calc, lines };
}

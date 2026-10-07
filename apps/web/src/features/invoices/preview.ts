import {
  calculateInvoice,
  DEFAULT_GST_POLICY,
  GstCalculationError,
  type InvoiceCalcResult,
} from '@factory-erp/gst';

export interface PreviewLine {
  quantity: string;
  unitRate: string;
  discountPercent: string;
  gstRatePercent: string | null;
}

export type PreviewResult =
  | { ok: true; result: InvoiceCalcResult }
  | { ok: false; message: string }
  | { ok: false; message: null };

/**
 * Client-side PREVIEW using the same pure engine as the server. It is never authoritative:
 * the server recomputes from its own item and rate data on save and again on issue.
 */
export function previewInvoice(args: {
  supplierStateCode: string | undefined;
  placeOfSupplyStateCode: string | undefined;
  lines: readonly PreviewLine[];
  invoiceRounding?: 'NEAREST_RUPEE' | 'NONE';
}): PreviewResult {
  const usable = args.lines.filter((l) => l.quantity.trim() !== '' && l.unitRate.trim() !== '');
  if (!args.supplierStateCode || !args.placeOfSupplyStateCode || usable.length === 0)
    return { ok: false, message: null };
  if (usable.some((l) => l.gstRatePercent === null))
    return { ok: false, message: 'An item has no GST rate configured' };
  try {
    return {
      ok: true,
      result: calculateInvoice({
        supplierStateCode: args.supplierStateCode,
        placeOfSupplyStateCode: args.placeOfSupplyStateCode,
        policy: {
          ...DEFAULT_GST_POLICY,
          invoiceRounding: args.invoiceRounding ?? DEFAULT_GST_POLICY.invoiceRounding,
        },
        lines: usable.map((l, i) => ({
          lineNo: i + 1,
          quantity: l.quantity.trim(),
          unitRate: l.unitRate.trim(),
          discountPercent: l.discountPercent.trim() || '0',
          gstRatePercent: l.gstRatePercent ?? '0',
        })),
      }),
    };
  } catch (e) {
    if (e instanceof GstCalculationError)
      return { ok: false, message: e.issues[0]?.message ?? 'Invalid line' };
    throw e;
  }
}

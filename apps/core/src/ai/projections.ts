import { z } from 'zod';

/**
 * What the model may see of each tool's result: an explicit allowlist of fields per tool.
 *
 * A projection is a Zod schema of plain objects, which keep only the fields they declare — so a
 * field added to a query's result later never reaches the model until it is listed here. A
 * result that does not match its projection is not shown at all (fail closed). A tool without
 * a projection is never offered to the model and never executed (see copilot.ts).
 */

export interface ToolProjection {
  schema: z.ZodType;
  /**
   * The list to shorten when the projected result is too large: '' when the result itself is
   * the list, a property name when it is a list inside an object, null when it cannot shrink.
   */
  list: string | null;
}

const money = z.string();
const id = z.string();

const partyRow = z.object({
  id,
  code: z.string(),
  name: z.string(),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
  gstin: z.string().nullable(),
  stateCode: z.string(),
  stateName: z.string(),
  creditDays: z.number().nullable(),
  status: z.string(),
  // Present only for users who may read receivables (the query decides; null otherwise).
  receivableBalance: money.nullable(),
  // Deliberately absent: contact name, phone, email, address and the row version.
});

const receivableAmounts = {
  invoicedAmount: money,
  creditedAmount: money,
  receivedAmount: money,
  balance: money,
  outstandingAmount: money,
  unallocatedAmount: money,
  openInvoiceCount: z.number(),
  ageing: z.record(z.string(), money),
};

const payableAmounts = {
  billedAmount: money,
  paidAmount: money,
  balance: money,
  outstandingAmount: money,
  unallocatedAmount: money,
  overdueAmount: money,
  dueThisWeekAmount: money,
  pendingApprovalAmount: money,
  openInvoiceCount: z.number(),
  overdueInvoiceCount: z.number(),
};

export const TOOL_PROJECTIONS: Readonly<Record<string, ToolProjection>> = {
  'parties.list': { schema: z.array(partyRow), list: '' },
  'finance.receivables.summary': {
    schema: z.object({
      asOf: z.string(),
      totals: z.object(receivableAmounts),
      customers: z.array(
        z.object({ customerId: id, code: z.string(), name: z.string(), ...receivableAmounts }),
      ),
    }),
    list: 'customers',
  },
  'finance.payables.summary': {
    schema: z.object({
      asOf: z.string(),
      totals: z.object(payableAmounts),
      suppliers: z.array(
        z.object({ supplierId: id, code: z.string(), name: z.string(), ...payableAmounts }),
      ),
    }),
    list: 'suppliers',
  },
  'inventory.stock.list': {
    schema: z.array(
      z.object({
        itemId: id,
        itemCode: z.string(),
        itemName: z.string(),
        itemType: z.string(),
        uom: z.string(),
        warehouseId: id,
        warehouseCode: z.string(),
        warehouseName: z.string(),
        quantity: z.string(),
      }),
    ),
    list: '',
  },
  'inventory.warehouses.list': {
    schema: z.array(z.object({ id, code: z.string(), name: z.string(), status: z.string() })),
    list: '',
  },
};

export type ProjectedResult =
  | { ok: true; json: string; truncated: boolean }
  | { ok: false; code: 'RESULT_INVALID' | 'RESULT_TOO_LARGE' };

/**
 * Project a tool's result and bound it to `maxChars` of JSON — the exact text the model gets.
 * A list too long is cut to the rows that fit (and says so); anything else too large, or not
 * matching its projection, is refused with a code.
 */
export function projectResult(
  definitionName: string,
  raw: unknown,
  maxChars: number,
): ProjectedResult {
  const projection = Object.hasOwn(TOOL_PROJECTIONS, definitionName)
    ? TOOL_PROJECTIONS[definitionName]
    : undefined;
  if (!projection) return { ok: false, code: 'RESULT_INVALID' };
  const parsed = projection.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'RESULT_INVALID' };
  const data: unknown = parsed.data;

  const whole = JSON.stringify({ ok: true, data, truncated: false });
  if (whole.length <= maxChars) return { ok: true, json: whole, truncated: false };
  if (projection.list === null) return { ok: false, code: 'RESULT_TOO_LARGE' };

  const listOf = (d: unknown): unknown[] =>
    projection.list === ''
      ? (d as unknown[])
      : ((d as Record<string, unknown[]>)[projection.list as string] ?? []);
  const all = listOf(data);
  const withRows = (n: number) =>
    JSON.stringify({
      ok: true,
      data:
        projection.list === ''
          ? all.slice(0, n)
          : { ...(data as Record<string, unknown>), [projection.list as string]: all.slice(0, n) },
      truncated: true,
      shown: n,
      total: all.length,
    });
  // The largest number of rows that fits (binary search; the size grows with the rows).
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (withRows(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  const json = withRows(lo);
  return json.length <= maxChars
    ? { ok: true, json, truncated: true }
    : { ok: false, code: 'RESULT_TOO_LARGE' };
}

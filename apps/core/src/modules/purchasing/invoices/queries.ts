import {
  ListPurchaseInvoicesQuery,
  PERMISSIONS,
  type MatchFinding,
  type MatchStatus,
  type PurchaseInvoiceDto,
  type PurchaseInvoiceListItemDto,
  type PurchaseInvoiceMatchDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { businessDate } from '../../../platform/clock';
import { NotFoundError } from '../../../platform/errors';
import { defineQuery } from '../../../platform/queries';
import { loadBuyer } from '../supplier';
import { loadPurchaseInvoiceDto, selectPurchaseInvoices, toPurchaseInvoiceListItem } from './dto';
import { evaluateMatch, matchStatusOf, tolerancesOf } from './evaluate';

export const listPurchaseInvoices = defineQuery({
  name: 'purchase.invoices.list',
  description:
    'Search supplier bills by our number, the supplier’s number or the supplier; filter by status, supplier or order.',
  input: ListPurchaseInvoicesQuery,
  permission: PERMISSIONS.purchaseInvoiceRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [{ description: 'Supplier bills still to be posted', input: { status: 'DRAFT' } }],
  handler: async ({ db, companyId, now }, input): Promise<PurchaseInvoiceListItemDto[]> => {
    let q = selectPurchaseInvoices(db, companyId);
    if (input.status) q = q.where('pi.status', '=', input.status);
    if (input.supplierId) q = q.where('pi.supplierId', '=', input.supplierId);
    if (input.orderId) q = q.where('pi.orderId', '=', input.orderId);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('pi.invoiceNumber', 'ilike', like),
          eb('pi.supplierInvoiceNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
          eb('p.code', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('pi.invoiceDate', 'desc')
      .orderBy('pi.createdAt', 'desc')
      .limit(input.limit)
      .execute();
    const today = businessDate(now);
    return rows.map((r) => toPurchaseInvoiceListItem(r, today));
  },
});

export const getPurchaseInvoice = defineQuery({
  name: 'purchase.invoices.get',
  description:
    'One supplier bill with its lines, three-way-match result, payments and what is still owed.',
  input: z.object({ invoiceId: z.uuid() }),
  permission: PERMISSIONS.purchaseInvoiceRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: ({ db, companyId, now }, input): Promise<PurchaseInvoiceDto> =>
    loadPurchaseInvoiceDto(db, companyId, input.invoiceId, businessDate(now)),
});

/**
 * The three-way match of one bill: for a draft, computed now from what has been received
 * and billed so far (posting reprices from master data and checks again under lock); for a
 * posted bill, the result recorded when it was posted.
 */
export const matchPurchaseInvoice = defineQuery({
  name: 'purchase.invoices.match',
  description:
    'Explain whether a supplier bill matches its purchase order and the goods received: quantity, price, item and total differences.',
  input: z.object({ invoiceId: z.uuid() }),
  permission: PERMISSIONS.purchaseInvoiceRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    {
      description: 'Why is this supplier invoice not matching the GRN?',
      input: { invoiceId: '01900000-0000-7000-8000-000000000007' },
    },
  ],
  handler: async ({ db, companyId }, input): Promise<PurchaseInvoiceMatchDto> => {
    const inv = await db
      .selectFrom('purchase.invoices')
      .select([
        'id',
        'status',
        'orderId',
        'grandTotal',
        'supplierStatedTotal',
        'matchStatus',
        'matchFindings',
      ])
      .where('companyId', '=', companyId)
      .where('id', '=', input.invoiceId)
      .executeTakeFirst();
    if (!inv) throw new NotFoundError('Purchase invoice');
    const tolerances = tolerancesOf(await loadBuyer(db, companyId));
    const base = {
      invoiceId: inv.id,
      basis: inv.orderId ? ('PURCHASE_ORDER' as const) : ('DIRECT' as const),
      computedTotal: inv.grandTotal,
      supplierStatedTotal: inv.supplierStatedTotal,
      tolerances,
    };
    if (inv.status === 'POSTED') {
      return {
        ...base,
        status: 'POSTED',
        findings: inv.matchFindings as unknown as MatchFinding[],
        matchStatus: inv.matchStatus as MatchStatus,
      };
    }
    const lines = await db
      .selectFrom('purchase.invoiceLines')
      .select(['lineNo', 'itemId', 'orderLineNo', 'quantity', 'unitRate', 'discountPercent'])
      .where('invoiceId', '=', inv.id)
      .orderBy('lineNo')
      .execute();
    const findings = await evaluateMatch(
      db,
      {
        companyId,
        orderId: inv.orderId,
        lines,
        computedTotal: inv.grandTotal,
        supplierStatedTotal: inv.supplierStatedTotal,
      },
      tolerances,
    );
    return {
      ...base,
      status: 'DRAFT',
      findings,
      matchStatus: matchStatusOf(inv.orderId, findings),
    };
  },
});

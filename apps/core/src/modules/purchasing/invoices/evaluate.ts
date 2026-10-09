import type { MatchFinding, MatchStatus } from '@factory-erp/contracts';
import { Qty } from '@factory-erp/money';
import { sql } from 'kysely';
import type { DbExecutor } from '../../../db/database';
import { threeWayMatch, type MatchTolerances } from './matching';

export interface MatchSubject {
  companyId: string;
  orderId: string | null;
  lines: ReadonlyArray<{
    lineNo: number;
    itemId: string;
    orderLineNo: number | null;
    quantity: string;
    unitRate: string;
    discountPercent: string;
  }>;
  computedTotal: string;
  supplierStatedTotal: string;
}

export const tolerancesOf = (company: {
  matchQtyTolerancePercent: string;
  matchPriceTolerancePercent: string;
  matchTotalTolerance: string;
}): MatchTolerances => ({
  qtyPercent: company.matchQtyTolerancePercent,
  pricePercent: company.matchPriceTolerancePercent,
  totalAmount: company.matchTotalTolerance,
});

export const matchStatusOf = (orderId: string | null, findings: readonly MatchFinding[]) =>
  (findings.length > 0
    ? 'ACCEPTED_WITH_DIFFERENCES'
    : orderId
      ? 'MATCHED'
      : 'NOT_APPLICABLE') satisfies MatchStatus;

/**
 * Gather what the three-way match compares — the order's lines, what has been accepted and
 * already billed (posted invoices only), and item codes for messages — then run the pure
 * match. When posting, the caller holds the order lock, so receipts cannot change meanwhile.
 */
export async function evaluateMatch(
  db: DbExecutor,
  subject: MatchSubject,
  tolerances: MatchTolerances,
): Promise<MatchFinding[]> {
  const orderLines = subject.orderId
    ? await db
        .selectFrom('purchase.orderLines as l')
        .innerJoin('purchase.orderLineProgress as g', (j) =>
          j.onRef('g.orderId', '=', 'l.orderId').onRef('g.lineNo', '=', 'l.lineNo'),
        )
        .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
        .select([
          'l.lineNo',
          'l.itemId',
          'i.code as itemCode',
          'l.unitRate',
          'l.discountPercent',
          sql<string>`g.accepted_quantity::text`.as('acceptedQuantity'),
          sql<string>`g.invoiced_quantity::text`.as('invoicedQuantity'),
        ])
        .where('l.orderId', '=', subject.orderId)
        .execute()
    : [];

  const itemIds = [...new Set(subject.lines.map((l) => l.itemId))];
  const items = itemIds.length
    ? await db
        .selectFrom('catalog.items')
        .select(['id', 'code'])
        .where('companyId', '=', subject.companyId)
        .where('id', 'in', itemIds)
        .execute()
    : [];
  const codeOf = new Map(items.map((i) => [i.id, i.code]));

  return threeWayMatch({
    tolerances,
    order: subject.orderId ? { lines: orderLines } : null,
    lines: subject.lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      itemCode: codeOf.get(l.itemId) ?? l.itemId,
      orderLineNo: l.orderLineNo,
      quantity: Qty.of(l.quantity).toString(),
      unitRate: l.unitRate,
      discountPercent: l.discountPercent,
    })),
    computedTotal: subject.computedTotal,
    supplierStatedTotal: subject.supplierStatedTotal,
  });
}

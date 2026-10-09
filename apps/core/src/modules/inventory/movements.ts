import { Dec, Qty } from '@factory-erp/money';
import { sql } from 'kysely';
import type { DbTransaction } from '../../db/database';
import { BusinessRuleError, ValidationError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';

/**
 * The inventory module's write API (Slice 1). Every stock change in the system — goods
 * received now; production and dispatch later — is recorded here, inside the caller's
 * transaction, so the business document and its stock effect commit together or not at all.
 *
 * Rules enforced here (and backed by SQL constraints):
 *  - items must belong to the company, be active and be stocked (services are not);
 *  - warehouses must belong to the company and be active;
 *  - OPENING and RECEIPT quantities are positive, ISSUE negative, ADJUSTMENT either way;
 *  - stock may never go below zero in a warehouse: outgoing lines lock the item/warehouse
 *    pair, then check the balance including every line of this call;
 *  - one movement per source document line (a unique index makes replays harmless).
 * Movements are append-only; corrections are compensating movements.
 */
export type StockMovementType = 'OPENING' | 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT';

export interface StockMovementLine {
  /** Line of the source document that caused this movement. */
  lineNo: number;
  itemId: string;
  warehouseId: string;
  /** Signed quantity in the item's unit: positive in, negative out. */
  quantity: string;
}

export interface RecordedMovement {
  id: string;
  lineNo: number;
  itemId: string;
  warehouseId: string;
  quantity: string;
  uom: string;
}

export async function recordStockMovements(
  tx: DbTransaction,
  args: {
    companyId: string;
    movementDate: string;
    movementType: StockMovementType;
    /** The business document that moves stock, e.g. { type: 'purchase.goods_receipt', … }. */
    source: { type: string; id: string; reference: string };
    lines: readonly StockMovementLine[];
    notes?: string | null;
    userId: string;
    now: Date;
  },
): Promise<RecordedMovement[]> {
  if (args.lines.length === 0) return [];
  const issues: Array<{ path: string; message: string }> = [];

  const quantities = args.lines.map((l, i) => {
    let q: Dec;
    try {
      q = Qty.of(l.quantity).toDecimal();
    } catch {
      issues.push({
        path: `lines.${i}.quantity`,
        message: 'Quantity has at most 3 decimal places',
      });
      return new Dec(0);
    }
    const ok =
      ((args.movementType === 'RECEIPT' || args.movementType === 'OPENING') && q.greaterThan(0)) ||
      (args.movementType === 'ISSUE' && q.lessThan(0)) ||
      (args.movementType === 'ADJUSTMENT' && !q.isZero());
    if (!ok) {
      issues.push({
        path: `lines.${i}.quantity`,
        message: `A ${args.movementType.toLowerCase()} cannot move ${q.toString()}`,
      });
    }
    return q;
  });

  const itemIds = [...new Set(args.lines.map((l) => l.itemId))];
  const warehouseIds = [...new Set(args.lines.map((l) => l.warehouseId))];
  const [items, warehouses] = await Promise.all([
    tx
      .selectFrom('catalog.items')
      .select(['id', 'name', 'uom', 'itemType', 'status'])
      .where('companyId', '=', args.companyId)
      .where('id', 'in', itemIds)
      .execute(),
    tx
      .selectFrom('inventory.warehouses')
      .select(['id', 'code', 'status'])
      .where('companyId', '=', args.companyId)
      .where('id', 'in', warehouseIds)
      .execute(),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]));

  args.lines.forEach((l, i) => {
    const item = itemById.get(l.itemId);
    if (!item) issues.push({ path: `lines.${i}.itemId`, message: 'Item not found' });
    else if (item.itemType === 'SERVICE')
      issues.push({
        path: `lines.${i}.itemId`,
        message: `${item.name} is a service; services are not stocked`,
      });
    else if (item.status !== 'ACTIVE' && args.movementType !== 'ADJUSTMENT')
      issues.push({ path: `lines.${i}.itemId`, message: `${item.name} is archived` });
    const wh = warehouseById.get(l.warehouseId);
    if (!wh) issues.push({ path: `lines.${i}.warehouseId`, message: 'Warehouse not found' });
    else if (wh.status !== 'ACTIVE')
      issues.push({ path: `lines.${i}.warehouseId`, message: `Warehouse ${wh.code} is archived` });
  });
  if (issues.length) throw new ValidationError(issues, 'Some stock movements are invalid');

  // Outgoing stock: serialise per item/warehouse (sorted, so concurrent callers cannot
  // deadlock), then check the balance — including every line of this call — stays ≥ 0.
  const outgoing = new Map<string, { itemId: string; warehouseId: string; delta: Dec }>();
  args.lines.forEach((l, i) => {
    const key = `${l.itemId}:${l.warehouseId}`;
    const entry = outgoing.get(key) ?? {
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      delta: new Dec(0),
    };
    entry.delta = entry.delta.plus(quantities[i] ?? 0);
    outgoing.set(key, entry);
  });
  for (const key of [...outgoing.keys()].sort()) {
    const o = outgoing.get(key);
    if (!o || !o.delta.isNegative()) continue;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 7243))`.execute(tx);
    const onHand = await tx
      .selectFrom('inventory.stockMovements')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('quantity'), sql<string>`0`).as('qty'))
      .where('companyId', '=', args.companyId)
      .where('itemId', '=', o.itemId)
      .where('warehouseId', '=', o.warehouseId)
      .executeTakeFirstOrThrow();
    const after = new Dec(onHand.qty).plus(o.delta);
    if (after.isNegative()) {
      const item = itemById.get(o.itemId);
      const wh = warehouseById.get(o.warehouseId);
      throw new BusinessRuleError(
        'INSUFFICIENT_STOCK',
        `Only ${new Dec(onHand.qty).toFixed(3)} ${item?.uom ?? ''} of ${item?.name ?? 'the item'} is in ${wh?.code ?? 'the warehouse'}; this would take it to ${after.toFixed(3)}`,
      );
    }
  }

  const rows = args.lines.map((l, i) => {
    const item = itemById.get(l.itemId);
    if (!item) throw new Error('unreachable: item validated above');
    return {
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      movementDate: args.movementDate,
      movementType: args.movementType,
      quantity: (quantities[i] ?? new Dec(0)).toFixed(3),
      uom: item.uom,
      sourceType: args.source.type,
      sourceId: args.source.id,
      sourceLineNo: l.lineNo,
      reference: args.source.reference,
      notes: args.notes ?? null,
      createdAt: args.now,
      createdBy: args.userId,
    };
  });
  await tx.insertInto('inventory.stockMovements').values(rows).execute();
  return rows.map((r, i) => ({
    id: r.id,
    lineNo: args.lines[i]?.lineNo ?? 0,
    itemId: r.itemId,
    warehouseId: r.warehouseId,
    quantity: r.quantity,
    uom: r.uom,
  }));
}

import type { GoodsReceiptDto, GoodsReceiptListItemDto } from '@factory-erp/contracts';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';

export function selectReceiptList(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('purchase.goodsReceipts as g')
    .innerJoin('purchase.orders as o', 'o.id', 'g.orderId')
    .innerJoin('party.parties as p', 'p.id', 'g.supplierId')
    .innerJoin('inventory.warehouses as w', 'w.id', 'g.warehouseId')
    .select([
      'g.id',
      'g.grnNumber',
      'g.receiptDate',
      'g.orderId',
      'o.poNumber',
      'g.supplierId',
      'p.name as supplierName',
      'w.code as warehouseCode',
      'g.supplierReference',
    ])
    .where('g.companyId', '=', companyId);
}

type ListRow = Awaited<ReturnType<ReturnType<typeof selectReceiptList>['execute']>>[number];

export const toReceiptListItem = (r: ListRow): GoodsReceiptListItemDto => ({
  ...r,
  poNumber: r.poNumber ?? '',
});

export async function loadReceiptDto(
  db: DbExecutor,
  companyId: string,
  grnId: string,
): Promise<GoodsReceiptDto> {
  const g = await selectReceiptList(db, companyId)
    .innerJoin('identity.users as u', 'u.id', 'g.createdBy')
    .select(['g.warehouseId', 'g.notes', 'g.createdAt', 'u.displayName as createdByName'])
    .where('g.id', '=', grnId)
    .executeTakeFirst();
  if (!g) throw new NotFoundError('Goods receipt');
  const lines = await db
    .selectFrom('purchase.goodsReceiptLines as l')
    .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
    .innerJoin('purchase.orderLines as ol', (j) =>
      j.onRef('ol.orderId', '=', 'l.orderId').onRef('ol.lineNo', '=', 'l.orderLineNo'),
    )
    .select([
      'l.lineNo',
      'l.orderLineNo',
      'l.itemId',
      'i.code as itemCode',
      'ol.description as itemName',
      'ol.uom',
      'l.receivedQuantity',
      'l.acceptedQuantity',
      'l.rejectedQuantity',
      'l.rejectionReason',
    ])
    .where('l.grnId', '=', grnId)
    .orderBy('l.lineNo')
    .execute();
  return {
    ...toReceiptListItem(g),
    warehouseId: g.warehouseId,
    notes: g.notes,
    lines,
    createdAt: g.createdAt.toISOString(),
    createdByName: g.createdByName,
  };
}

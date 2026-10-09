import {
  ListGoodsReceiptsQuery,
  PERMISSIONS,
  type GoodsReceiptDto,
  type GoodsReceiptListItemDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { defineQuery } from '../../../platform/queries';
import { loadReceiptDto, selectReceiptList, toReceiptListItem } from './dto';

export const listGoodsReceipts = defineQuery({
  name: 'purchase.grns.list',
  description: 'Goods receipts (GRNs), newest first; filter by order or supplier.',
  input: ListGoodsReceiptsQuery,
  permission: PERMISSIONS.purchaseOrderRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId }, input): Promise<GoodsReceiptListItemDto[]> => {
    let q = selectReceiptList(db, companyId);
    if (input.orderId) q = q.where('g.orderId', '=', input.orderId);
    if (input.supplierId) q = q.where('g.supplierId', '=', input.supplierId);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('g.grnNumber', 'ilike', like),
          eb('o.poNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
          eb('g.supplierReference', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('g.receiptDate', 'desc')
      .orderBy('g.grnNumber', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toReceiptListItem);
  },
});

export const getGoodsReceipt = defineQuery({
  name: 'purchase.grns.get',
  description: 'One goods receipt with its lines (accepted and rejected quantities).',
  input: z.object({ grnId: z.uuid() }),
  permission: PERMISSIONS.purchaseOrderRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: ({ db, companyId }, input): Promise<GoodsReceiptDto> =>
    loadReceiptDto(db, companyId, input.grnId),
});

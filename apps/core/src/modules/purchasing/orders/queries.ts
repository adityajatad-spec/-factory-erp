import {
  ListPurchaseOrdersQuery,
  PERMISSIONS,
  type PurchaseOrderDto,
  type PurchaseOrderListItemDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { businessDate } from '../../../platform/clock';
import { defineQuery } from '../../../platform/queries';
import { loadOrderDto, selectOrderList, toOrderListItem } from './dto';

export const listPurchaseOrders = defineQuery({
  name: 'purchase.orders.list',
  description: 'Search purchase orders by number or supplier; filter open or overdue orders.',
  input: ListPurchaseOrdersQuery,
  permission: PERMISSIONS.purchaseOrderRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    { description: 'Which purchase orders are overdue?', input: { overdue: 'true' } },
    { description: 'Orders still expecting goods', input: { open: 'true' } },
  ],
  handler: async ({ db, companyId, now }, input): Promise<PurchaseOrderListItemDto[]> => {
    const today = businessDate(now);
    let q = selectOrderList(db, companyId);
    if (input.status) q = q.where('o.status', '=', input.status);
    if (input.supplierId) q = q.where('o.supplierId', '=', input.supplierId);
    if (input.open || input.overdue)
      q = q.where('o.status', 'in', ['APPROVED', 'PARTIALLY_RECEIVED']);
    if (input.overdue) q = q.where('o.expectedDate', '<', today);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('o.poNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
          eb('p.code', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('o.poDate', 'desc')
      .orderBy('o.poNumber', 'desc')
      .orderBy('o.createdAt', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map((r) => toOrderListItem(r, today));
  },
});

export const getPurchaseOrder = defineQuery({
  name: 'purchase.orders.get',
  description:
    'One purchase order with its lines, what has been received and invoiced, and its receipts.',
  input: z.object({ orderId: z.uuid() }),
  permission: PERMISSIONS.purchaseOrderRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: ({ db, companyId, now }, input): Promise<PurchaseOrderDto> =>
    loadOrderDto(db, companyId, input.orderId, businessDate(now)),
});

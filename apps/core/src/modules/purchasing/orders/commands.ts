import {
  CreatePurchaseOrderRequest,
  PERMISSIONS,
  PurchaseOrderReasonRequest,
  PurchaseOrderVersionRequest,
  UpdatePurchaseOrderRequest,
  type PurchaseOrderDto,
} from '@factory-erp/contracts';
import type { z } from 'zod';
import type { DbTransaction } from '../../../db/database';
import { businessDate } from '../../../platform/clock';
import { defineCommand } from '../../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../../platform/errors';
import { uuidv7 } from '../../../platform/ids';
import { toJsonb } from '../../../platform/json';
import { allocateDocumentNumber } from '../../../platform/numbering';
import { PURCHASE_ORDER_APPROVED_TOPIC } from '../pdf/topics';
import { loadBuyer, loadSupplier, pricePurchase, supplierSnapshot } from '../supplier';
import { loadOrderDto } from './dto';
import { orderTotals, replaceOrderLines } from './store';

type OrderBody = z.output<typeof CreatePurchaseOrderRequest>;

async function assertReceivingWarehouse(tx: DbTransaction, companyId: string, warehouseId: string) {
  const wh = await tx
    .selectFrom('inventory.warehouses')
    .select(['code', 'status'])
    .where('companyId', '=', companyId)
    .where('id', '=', warehouseId)
    .executeTakeFirst();
  if (!wh) throw new NotFoundError('Warehouse');
  if (wh.status !== 'ACTIVE')
    throw new BusinessRuleError('WAREHOUSE_ARCHIVED', `Warehouse ${wh.code} is archived`);
}

async function priceOrder(tx: DbTransaction, companyId: string, body: OrderBody) {
  const buyer = await loadBuyer(tx, companyId);
  const supplier = await loadSupplier(tx, companyId, body.supplierId);
  await assertReceivingWarehouse(tx, companyId, body.warehouseId);
  const priced = await pricePurchase(tx, {
    companyId,
    documentDate: body.poDate,
    supplierStateCode: supplier.stateCode,
    buyerStateCode: buyer.stateCode,
    invoiceRounding: buyer.invoiceRounding,
    lines: body.lines,
  });
  return { ...priced, buyer, supplier };
}

const auditSummary = (o: PurchaseOrderDto) => ({
  status: o.status,
  poNumber: o.poNumber,
  supplierId: o.supplierId,
  warehouseId: o.warehouseId,
  poDate: o.poDate,
  expectedDate: o.expectedDate,
  grandTotal: o.grandTotal,
  lineCount: o.lines.length,
  version: o.version,
});

export const createPurchaseOrderDraft = defineCommand({
  name: 'purchase.order.createDraft',
  description:
    'Draft a purchase order to a supplier. Prices and GST are computed by the server; a human approves it.',
  input: CreatePurchaseOrderRequest,
  permission: PERMISSIONS.purchaseOrderDraft,
  ai: { tier: 'DRAFT' },
  examples: [
    {
      description: 'Draft a PO for 500 kg of a raw material, delivered to the raw-material store',
      input: {
        supplierId: '01900000-0000-7000-8000-000000000003',
        warehouseId: '01900000-0000-7000-8000-000000000004',
        poDate: '2026-10-08',
        expectedDate: '2026-10-15',
        lines: [
          { itemId: '01900000-0000-7000-8000-000000000005', quantity: '500', unitRate: '68.50' },
        ],
      },
    },
  ],
  handler: async ({ tx, actor, companyId, now }, input) => {
    const priced = await priceOrder(tx, companyId, input);
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('purchase.orders')
      .values({
        id,
        companyId,
        status: 'DRAFT',
        poDate: input.poDate,
        expectedDate: input.expectedDate,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        supplierStateCode: priced.supplier.stateCode,
        placeOfSupplyStateCode: priced.buyer.stateCode,
        notes: input.notes,
        ...orderTotals(priced.calc),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();
    await replaceOrderLines(tx, id, priced.lines);
    const order = await loadOrderDto(tx, companyId, id, businessDate(now));
    return {
      result: order,
      audit: [{ entityType: 'purchase.order', entityId: id, after: auditSummary(order) }],
    };
  },
});

async function lockOrder(
  tx: DbTransaction,
  companyId: string,
  orderId: string,
  expectedVersion: number,
) {
  const o = await tx
    .selectFrom('purchase.orders')
    .selectAll()
    .where('companyId', '=', companyId)
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
  if (!o) throw new NotFoundError('Purchase order');
  if (o.version !== expectedVersion) throw new VersionConflictError('Purchase order');
  return o;
}

function assertStatus(
  o: { status: string; poNumber: string | null },
  allowed: readonly string[],
  action: string,
) {
  if (!allowed.includes(o.status)) {
    throw new BusinessRuleError(
      'PURCHASE_ORDER_STATUS',
      `Purchase order ${o.poNumber ?? '(draft)'} is ${o.status}; it cannot be ${action}`,
    );
  }
}

export const updatePurchaseOrderDraft = defineCommand({
  name: 'purchase.order.updateDraft',
  description: 'Replace the content of a draft purchase order (optimistic concurrency).',
  input: UpdatePurchaseOrderRequest,
  permission: PERMISSIONS.purchaseOrderDraft,
  ai: { tier: 'DRAFT' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockOrder(tx, companyId, input.orderId, input.expectedVersion);
    assertStatus(before, ['DRAFT'], 'edited');
    const priced = await priceOrder(tx, companyId, input);
    await tx
      .updateTable('purchase.orders')
      .set({
        poDate: input.poDate,
        expectedDate: input.expectedDate,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        supplierStateCode: priced.supplier.stateCode,
        placeOfSupplyStateCode: priced.buyer.stateCode,
        notes: input.notes,
        ...orderTotals(priced.calc),
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();
    await replaceOrderLines(tx, before.id, priced.lines);
    const order = await loadOrderDto(tx, companyId, before.id, businessDate(now));
    return {
      result: order,
      audit: [
        {
          entityType: 'purchase.order',
          entityId: before.id,
          before: {
            grandTotal: before.grandTotal,
            supplierId: before.supplierId,
            version: before.version,
          },
          after: auditSummary(order),
        },
      ],
    };
  },
});

export const deletePurchaseOrderDraft = defineCommand({
  name: 'purchase.order.deleteDraft',
  description: 'Delete a draft purchase order (approved orders are cancelled or closed instead).',
  input: PurchaseOrderVersionRequest,
  permission: PERMISSIONS.purchaseOrderDraft,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, companyId }, input) => {
    const before = await lockOrder(tx, companyId, input.orderId, input.expectedVersion);
    assertStatus(before, ['DRAFT'], 'deleted');
    await tx.deleteFrom('purchase.orders').where('id', '=', before.id).execute();
    return {
      result: { deleted: true as const },
      audit: [
        {
          entityType: 'purchase.order',
          entityId: before.id,
          before: { status: 'DRAFT', grandTotal: before.grandTotal, supplierId: before.supplierId },
          after: { deleted: true },
        },
      ],
    };
  },
});

export const approvePurchaseOrder = defineCommand({
  name: 'purchase.order.approve',
  description:
    'Approve a draft purchase order: it is repriced, numbered and frozen, and can then be received against.',
  input: PurchaseOrderVersionRequest,
  permission: PERMISSIONS.purchaseOrderApprove,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockOrder(tx, companyId, input.orderId, input.expectedVersion);
    assertStatus(before, ['DRAFT'], 'approved');
    const today = businessDate(now);
    if (before.poDate > today) {
      throw new BusinessRuleError(
        'PO_DATE_IN_FUTURE',
        `PO date ${before.poDate} is after today (${today})`,
      );
    }
    const storedLines = await tx
      .selectFrom('purchase.orderLines')
      .select(['itemId', 'description', 'quantity', 'unitRate', 'discountPercent'])
      .where('orderId', '=', before.id)
      .orderBy('lineNo')
      .execute();
    // Reprice from current master data and the rates in force on the PO date.
    const priced = await priceOrder(tx, companyId, {
      supplierId: before.supplierId,
      warehouseId: before.warehouseId,
      poDate: before.poDate,
      expectedDate: before.expectedDate,
      notes: before.notes,
      lines: storedLines,
    });
    await replaceOrderLines(tx, before.id, priced.lines);
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'PURCHASE_ORDER',
      prefix: priced.buyer.poPrefix,
      documentDate: before.poDate,
      now,
    });
    await tx
      .updateTable('purchase.orders')
      .set({
        ...orderTotals(priced.calc),
        supplierStateCode: priced.supplier.stateCode,
        status: 'APPROVED',
        poNumber: documentNumber,
        fiscalYear,
        supplierSnapshot: toJsonb(supplierSnapshot(priced.supplier)),
        approvedAt: now,
        approvedBy: actor.user.id,
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();
    const order = await loadOrderDto(tx, companyId, before.id, today);
    return {
      result: order,
      audit: [
        {
          entityType: 'purchase.order',
          entityId: before.id,
          before: { status: 'DRAFT', grandTotal: before.grandTotal, version: before.version },
          after: auditSummary(order),
        },
      ],
      // The PDF is a side effect: approval never waits for (or fails with) the renderer.
      outbox: [
        {
          topic: PURCHASE_ORDER_APPROVED_TOPIC,
          aggregateType: 'purchase.order',
          aggregateId: before.id,
          payload: { orderId: before.id, companyId },
        },
      ],
    };
  },
});

async function endOrder(
  { tx, actor, companyId, now }: Parameters<(typeof approvePurchaseOrder)['handler']>[0],
  input: z.output<typeof PurchaseOrderReasonRequest>,
  kind: 'cancel' | 'close',
) {
  const before = await lockOrder(tx, companyId, input.orderId, input.expectedVersion);
  if (kind === 'cancel') {
    assertStatus(before, ['DRAFT', 'APPROVED'], 'cancelled');
    const received = await tx
      .selectFrom('purchase.goodsReceipts')
      .select('id')
      .where('orderId', '=', before.id)
      .executeTakeFirst();
    if (received) {
      throw new BusinessRuleError(
        'PURCHASE_ORDER_HAS_RECEIPTS',
        `Goods were already received against ${before.poNumber ?? 'this order'}; close it instead`,
      );
    }
  } else {
    assertStatus(before, ['APPROVED', 'PARTIALLY_RECEIVED'], 'closed');
  }
  const ending =
    kind === 'cancel'
      ? {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledBy: actor.user.id,
          cancelReason: input.reason,
        }
      : { status: 'CLOSED', closedAt: now, closedBy: actor.user.id, closeReason: input.reason };
  await tx
    .updateTable('purchase.orders')
    .set({ ...ending, version: before.version + 1, updatedAt: now, updatedBy: actor.user.id })
    .where('id', '=', before.id)
    .execute();
  const order = await loadOrderDto(tx, companyId, before.id, businessDate(now));
  return {
    result: order,
    audit: [
      {
        entityType: 'purchase.order',
        entityId: before.id,
        before: { status: before.status, version: before.version },
        after: { status: order.status, reason: input.reason, version: order.version },
      },
    ] as const,
  };
}

export const cancelPurchaseOrder = defineCommand({
  name: 'purchase.order.cancel',
  description: 'Cancel a purchase order that nothing has been received against, with a reason.',
  input: PurchaseOrderReasonRequest,
  permission: PERMISSIONS.purchaseOrderCancel,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => endOrder(ctx, input, 'cancel'),
});

export const closePurchaseOrder = defineCommand({
  name: 'purchase.order.close',
  description:
    'Short-close an approved or partly received purchase order: the remaining quantity will not be delivered.',
  input: PurchaseOrderReasonRequest,
  permission: PERMISSIONS.purchaseOrderCancel,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => endOrder(ctx, input, 'close'),
});

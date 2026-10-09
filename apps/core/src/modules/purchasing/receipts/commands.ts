import { PERMISSIONS, RecordGoodsReceiptRequest } from '@factory-erp/contracts';
import { Dec } from '@factory-erp/money';
import { businessDate } from '../../../platform/clock';
import { defineCommand } from '../../../platform/commands';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../../platform/errors';
import { uuidv7 } from '../../../platform/ids';
import { allocateDocumentNumber } from '../../../platform/numbering';
import { recordStockMovements } from '../../inventory';
import { loadBuyer } from '../supplier';
import { loadReceiptDto } from './dto';

/** The source document type stock movements point back to. */
export const GOODS_RECEIPT_SOURCE = 'purchase.goods_receipt';

/**
 * Record goods received against an approved purchase order — one transaction:
 *   lock the order → check every line against what remains (on the locked state) → number the
 *   receipt → record it → put accepted goods into stock through the inventory module → move the
 *   order to PARTIALLY_RECEIVED or RECEIVED → audit.
 * Rejected quantity needs a reason, is not stocked and does not use up the order. Over-receipt
 * is refused here and again at COMMIT by SQL (FO006). Services are received but not stocked.
 */
export const recordGoodsReceipt = defineCommand({
  name: 'purchase.grn.record',
  description:
    'Record goods received against an approved purchase order. Accepted quantities go into stock; rejected ones need a reason.',
  input: RecordGoodsReceiptRequest,
  permission: PERMISSIONS.goodsReceiptRecord,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const order = await tx
      .selectFrom('purchase.orders')
      .select(['id', 'status', 'poNumber', 'poDate', 'supplierId', 'warehouseId', 'version'])
      .where('companyId', '=', companyId)
      .where('id', '=', input.orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) throw new NotFoundError('Purchase order');
    if (order.status !== 'APPROVED' && order.status !== 'PARTIALLY_RECEIVED') {
      throw new BusinessRuleError(
        'PURCHASE_ORDER_NOT_OPEN',
        `Purchase order ${order.poNumber ?? '(draft)'} is ${order.status}; goods can only be received against an approved order`,
      );
    }
    const today = businessDate(now);
    if (input.receiptDate > today) {
      throw new BusinessRuleError(
        'RECEIPT_DATE_IN_FUTURE',
        `Receipt date ${input.receiptDate} is after today (${today})`,
      );
    }
    if (input.receiptDate < order.poDate) {
      throw new BusinessRuleError(
        'RECEIPT_BEFORE_ORDER',
        `Goods cannot be received on ${input.receiptDate}, before the order date ${order.poDate}`,
      );
    }

    // Read progress only now that the order is locked: concurrent receipts queue on the lock.
    const lines = await tx
      .selectFrom('purchase.orderLines as l')
      .innerJoin('purchase.orderLineProgress as g', (j) =>
        j.onRef('g.orderId', '=', 'l.orderId').onRef('g.lineNo', '=', 'l.lineNo'),
      )
      .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
      .select([
        'l.lineNo',
        'l.itemId',
        'l.description',
        'l.uom',
        'l.quantity',
        'g.remainingQuantity',
        'i.itemType',
      ])
      .where('l.orderId', '=', order.id)
      .execute();
    const byLine = new Map(lines.map((l) => [l.lineNo, l]));

    const issues: Array<{ path: string; message: string }> = [];
    const accepted = input.lines.map((l, i) => {
      const ol = byLine.get(l.orderLineNo);
      const acc = new Dec(l.acceptedQuantity);
      const rej = new Dec(l.rejectedQuantity);
      if (!ol) {
        issues.push({
          path: `lines.${i}.orderLineNo`,
          message: `The order has no line ${l.orderLineNo}`,
        });
        return acc;
      }
      if (acc.plus(rej).isZero()) {
        issues.push({
          path: `lines.${i}.acceptedQuantity`,
          message: `Line ${l.orderLineNo}: nothing received`,
        });
      }
      if (!rej.isZero() && !l.rejectionReason) {
        issues.push({
          path: `lines.${i}.rejectionReason`,
          message: `Line ${l.orderLineNo}: say why goods were rejected`,
        });
      }
      const remaining = new Dec(ol.remainingQuantity ?? '0');
      if (acc.greaterThan(remaining)) {
        issues.push({
          path: `lines.${i}.acceptedQuantity`,
          message: `Line ${l.orderLineNo} (${ol.description}): only ${remaining.toFixed(3)} ${ol.uom} remain on the order; ${acc.toFixed(3)} cannot be accepted`,
        });
      }
      return acc;
    });
    if (issues.some((x) => /remain on the order/.test(x.message))) {
      throw new BusinessRuleError('OVER_RECEIPT', issues.map((x) => x.message).join('; '), issues);
    }
    if (issues.length) throw new ValidationError(issues, 'The goods receipt is invalid');

    const buyer = await loadBuyer(tx, companyId);
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'GOODS_RECEIPT',
      prefix: buyer.grnPrefix,
      documentDate: input.receiptDate,
      now,
    });
    const grnId = uuidv7(now.getTime());
    await tx
      .insertInto('purchase.goodsReceipts')
      .values({
        id: grnId,
        companyId,
        grnNumber: documentNumber,
        fiscalYear,
        receiptDate: input.receiptDate,
        orderId: order.id,
        supplierId: order.supplierId,
        warehouseId: order.warehouseId,
        supplierReference: input.supplierReference,
        notes: input.notes,
        createdAt: now,
        createdBy: actor.user.id,
      })
      .execute();
    const grnLines = input.lines.map((l, i) => {
      const ol = byLine.get(l.orderLineNo);
      if (!ol) throw new Error('unreachable: line validated above');
      const acc = accepted[i] ?? new Dec(0);
      const rej = new Dec(l.rejectedQuantity);
      return {
        grnId,
        lineNo: i + 1,
        orderId: order.id,
        orderLineNo: l.orderLineNo,
        itemId: ol.itemId,
        receivedQuantity: acc.plus(rej).toFixed(3),
        acceptedQuantity: acc.toFixed(3),
        rejectedQuantity: rej.toFixed(3),
        rejectionReason: rej.isZero() ? null : l.rejectionReason,
        itemType: ol.itemType,
      };
    });
    await tx
      .insertInto('purchase.goodsReceiptLines')
      .values(grnLines.map(({ itemType: _t, ...l }) => l))
      .execute();

    // Stock: the inventory module owns the movement; purchasing only says what came in.
    const movements = await recordStockMovements(tx, {
      companyId,
      movementDate: input.receiptDate,
      movementType: 'RECEIPT',
      source: { type: GOODS_RECEIPT_SOURCE, id: grnId, reference: documentNumber },
      lines: grnLines
        .filter((l) => l.itemType !== 'SERVICE' && new Dec(l.acceptedQuantity).greaterThan(0))
        .map((l) => ({
          lineNo: l.lineNo,
          itemId: l.itemId,
          warehouseId: order.warehouseId,
          quantity: l.acceptedQuantity,
        })),
      userId: actor.user.id,
      now,
    });

    // Receiving status follows ACCEPTED quantity: a delivery that was all rejected leaves the
    // order as it was; nothing has been received into stock yet.
    const progress = await tx
      .selectFrom('purchase.orderLineProgress')
      .select([
        (eb) => eb.fn.sum<string>('acceptedQuantity').as('accepted'),
        (eb) => eb.fn.sum<string>('remainingQuantity').as('remaining'),
      ])
      .where('orderId', '=', order.id)
      .executeTakeFirstOrThrow();
    const newStatus = new Dec(progress.remaining ?? '0').isZero()
      ? 'RECEIVED'
      : new Dec(progress.accepted ?? '0').isZero()
        ? order.status
        : 'PARTIALLY_RECEIVED';
    await tx
      .updateTable('purchase.orders')
      .set({
        status: newStatus,
        version: order.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', order.id)
      .execute();

    const receipt = await loadReceiptDto(tx, companyId, grnId);
    return {
      result: receipt,
      audit: [
        {
          entityType: 'purchase.goods_receipt',
          entityId: grnId,
          after: {
            grnNumber: documentNumber,
            orderId: order.id,
            receiptDate: input.receiptDate,
            lines: receipt.lines.map((l) => ({
              orderLineNo: l.orderLineNo,
              accepted: l.acceptedQuantity,
              rejected: l.rejectedQuantity,
            })),
            stockMovements: movements.length,
          },
        },
        {
          entityType: 'purchase.order',
          entityId: order.id,
          before: { status: order.status, version: order.version },
          after: { status: newStatus, version: order.version + 1, grnNumber: documentNumber },
        },
      ],
    };
  },
});

import {
  CreateWarehouseRequest,
  PERMISSIONS,
  StockAdjustmentRequest,
  type StockAdjustmentDto,
} from '@factory-erp/contracts';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, DuplicateError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { allocateDocumentNumber } from '../../platform/numbering';
import { selectWarehouses, toWarehouseDto } from './dto';
import { recordStockMovements } from './movements';

export const createWarehouse = defineCommand({
  name: 'inventory.warehouse.create',
  description: 'Create a warehouse or store location that stock can be received into.',
  input: CreateWarehouseRequest,
  permission: PERMISSIONS.inventoryWarehouseManage,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const clash = await tx
      .selectFrom('inventory.warehouses')
      .select('id')
      .where('companyId', '=', companyId)
      .where('code', '=', input.code)
      .executeTakeFirst();
    if (clash) throw new DuplicateError(`Warehouse code ${input.code} is already in use`);
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('inventory.warehouses')
      .values({
        id,
        companyId,
        code: input.code,
        name: input.name,
        createdAt: now,
        createdBy: actor.user.id,
      })
      .execute();
    const warehouse = toWarehouseDto(
      await selectWarehouses(tx, companyId).where('id', '=', id).executeTakeFirstOrThrow(),
    );
    return {
      result: warehouse,
      audit: [{ entityType: 'inventory.warehouse', entityId: id, after: warehouse }],
    };
  },
});

export const adjustStock = defineCommand({
  name: 'inventory.stock.adjust',
  description:
    'Correct stock with compensating movements (physical count, damage, a mis-posted receipt). A reason is required; stock can never go below zero.',
  input: StockAdjustmentRequest,
  permission: PERMISSIONS.inventoryStockAdjust,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const today = businessDate(now);
    if (input.adjustmentDate > today) {
      throw new BusinessRuleError(
        'ADJUSTMENT_DATE_IN_FUTURE',
        `Adjustment date ${input.adjustmentDate} is after today (${today})`,
      );
    }
    const { documentNumber } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'STOCK_ADJUSTMENT',
      prefix: 'ADJ',
      documentDate: input.adjustmentDate,
      now,
    });
    const adjustmentId = uuidv7(now.getTime());
    const movements = await recordStockMovements(tx, {
      companyId,
      movementDate: input.adjustmentDate,
      movementType: 'ADJUSTMENT',
      source: { type: 'inventory.adjustment', id: adjustmentId, reference: documentNumber },
      lines: input.lines.map((l, i) => ({
        lineNo: i + 1,
        itemId: l.itemId,
        warehouseId: input.warehouseId,
        quantity: l.quantity,
      })),
      notes: input.reason,
      userId: actor.user.id,
      now,
    });
    const result: StockAdjustmentDto = {
      reference: documentNumber,
      adjustmentDate: input.adjustmentDate,
      warehouseId: input.warehouseId,
      movements: movements.map((m) => ({ itemId: m.itemId, quantity: m.quantity, uom: m.uom })),
    };
    return {
      result,
      audit: [
        {
          entityType: 'inventory.adjustment',
          entityId: adjustmentId,
          after: { ...result, reason: input.reason },
        },
      ],
    };
  },
});

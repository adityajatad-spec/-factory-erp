import {
  ListStockMovementsQuery,
  ListStockQuery,
  PERMISSIONS,
  type ItemType,
  type StockLevelDto,
  type StockMovementDto,
  type WarehouseDto,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { defineQuery } from '../../platform/queries';
import { selectMovements, selectWarehouses, toMovementDto, toWarehouseDto } from './dto';

export const listWarehouses = defineQuery({
  name: 'inventory.warehouses.list',
  description: 'Warehouses and store locations of the company.',
  input: z.object({}),
  permission: PERMISSIONS.inventoryStockRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId }): Promise<WarehouseDto[]> =>
    (await selectWarehouses(db, companyId).orderBy('code').execute()).map(toWarehouseDto),
});

export const listStock = defineQuery({
  name: 'inventory.stock.list',
  description: 'Stock on hand per item and warehouse, derived from the stock ledger.',
  input: ListStockQuery,
  permission: PERMISSIONS.inventoryStockRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  examples: [{ description: 'Everything in stock', input: {} }],
  handler: async ({ db, companyId }, input): Promise<StockLevelDto[]> => {
    let q = db
      .selectFrom('inventory.stockOnHand as s')
      .innerJoin('catalog.items as i', 'i.id', 's.itemId')
      .innerJoin('inventory.warehouses as w', 'w.id', 's.warehouseId')
      .select([
        'i.id as itemId',
        'i.code as itemCode',
        'i.name as itemName',
        'i.itemType',
        'i.uom',
        'w.id as warehouseId',
        'w.code as warehouseCode',
        'w.name as warehouseName',
        sql<string>`coalesce(s.quantity, 0)::numeric(18,3)::text`.as('quantity'),
      ])
      .where('s.companyId', '=', companyId);
    if (input.warehouseId) q = q.where('s.warehouseId', '=', input.warehouseId);
    if (input.itemId) q = q.where('s.itemId', '=', input.itemId);
    if (!input.includeZero) q = q.where('s.quantity', '<>', '0');
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) => eb.or([eb('i.name', 'ilike', like), eb('i.code', 'ilike', like)]));
    }
    const rows = await q.orderBy('i.name').orderBy('w.code').limit(input.limit).execute();
    return rows.map((r) => ({ ...r, itemType: r.itemType as ItemType }));
  },
});

export const listStockMovements = defineQuery({
  name: 'inventory.movements.list',
  description: 'The stock ledger: every movement of an item, warehouse or document, newest first.',
  input: ListStockMovementsQuery,
  permission: PERMISSIONS.inventoryStockRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId }, input): Promise<StockMovementDto[]> => {
    let q = selectMovements(db, companyId);
    if (input.itemId) q = q.where('m.itemId', '=', input.itemId);
    if (input.warehouseId) q = q.where('m.warehouseId', '=', input.warehouseId);
    if (input.sourceId) q = q.where('m.sourceId', '=', input.sourceId);
    const rows = await q
      .orderBy('m.movementDate', 'desc')
      .orderBy('m.id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toMovementDto);
  },
});

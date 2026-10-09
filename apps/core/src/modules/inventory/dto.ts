import type { StockMovementDto, StockMovementType, WarehouseDto } from '@factory-erp/contracts';
import type { DbExecutor } from '../../db/database';

export function selectWarehouses(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('inventory.warehouses')
    .select(['id', 'code', 'name', 'status'])
    .where('companyId', '=', companyId);
}

export function toWarehouseDto(w: {
  id: string;
  code: string;
  name: string;
  status: string;
}): WarehouseDto {
  return { ...w, status: w.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE' };
}

export function selectMovements(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('inventory.stockMovements as m')
    .innerJoin('catalog.items as i', 'i.id', 'm.itemId')
    .innerJoin('inventory.warehouses as w', 'w.id', 'm.warehouseId')
    .select([
      'm.id',
      'm.movementDate',
      'm.movementType',
      'm.quantity',
      'm.uom',
      'm.itemId',
      'i.code as itemCode',
      'i.name as itemName',
      'm.warehouseId',
      'w.code as warehouseCode',
      'm.sourceType',
      'm.sourceId',
      'm.reference',
      'm.notes',
      'm.createdAt',
    ])
    .where('m.companyId', '=', companyId);
}

type MovementRow = Awaited<ReturnType<ReturnType<typeof selectMovements>['execute']>>[number];

export function toMovementDto(r: MovementRow): StockMovementDto {
  return {
    ...r,
    movementType: r.movementType as StockMovementType,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Public API of the inventory module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { adjustStock, createWarehouse } from './commands';
export {
  recordStockMovements,
  type RecordedMovement,
  type StockMovementLine,
  type StockMovementType,
} from './movements';
export { listStock, listStockMovements, listWarehouses } from './queries';

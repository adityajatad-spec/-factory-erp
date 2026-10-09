import { z } from 'zod';
import { IsoDate, SearchQuery, Uuid } from './common';
import type { ItemType } from './items';

export const STOCK_MOVEMENT_TYPES = ['OPENING', 'RECEIPT', 'ISSUE', 'ADJUSTMENT'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** A signed quantity (adjustments may add or remove), at most 3 decimals, never zero. */
export const SignedQtyString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,3})?$/, 'Expected a quantity like "12.5" or "-3"')
  .refine((s) => /[1-9]/.test(s), 'Quantity must not be zero');

export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export const CreateWarehouseRequest = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,20}$/, 'Code: 2–20 letters, digits or hyphens'),
  name: z.string().trim().min(2).max(100),
});
export type CreateWarehouseRequest = z.input<typeof CreateWarehouseRequest>;

/**
 * Correct stock that is wrong (a physical count, damage, a receipt booked to the wrong place).
 * Recorded as compensating movements with a mandatory reason — nothing is ever edited.
 */
export const StockAdjustmentRequest = z.object({
  warehouseId: Uuid,
  adjustmentDate: IsoDate,
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500),
  lines: z
    .array(z.object({ itemId: Uuid, quantity: SignedQtyString }))
    .min(1, 'Adjust at least one item')
    .max(200)
    .refine((ls) => new Set(ls.map((l) => l.itemId)).size === ls.length, 'Each item only once'),
});
export type StockAdjustmentRequest = z.input<typeof StockAdjustmentRequest>;

export interface StockAdjustmentDto {
  reference: string;
  adjustmentDate: string;
  warehouseId: string;
  movements: Array<{ itemId: string; quantity: string; uom: string }>;
}

export const ListStockQuery = SearchQuery.extend({
  warehouseId: Uuid.optional(),
  itemId: Uuid.optional(),
  /** Include item/warehouse pairs whose balance is zero. */
  includeZero: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListStockQuery = z.input<typeof ListStockQuery>;

export interface StockLevelDto {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: ItemType;
  uom: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  /** Derived: the sum of the item's movements in the warehouse. */
  quantity: string;
}

export const ListStockMovementsQuery = z.object({
  itemId: Uuid.optional(),
  warehouseId: Uuid.optional(),
  sourceId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListStockMovementsQuery = z.input<typeof ListStockMovementsQuery>;

export interface StockMovementDto {
  id: string;
  movementDate: string;
  movementType: StockMovementType;
  quantity: string;
  uom: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  /** The document that moved the stock, e.g. "purchase.goods_receipt". */
  sourceType: string | null;
  sourceId: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
}

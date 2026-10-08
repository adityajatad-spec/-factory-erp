import { z } from 'zod';
import { RateString, SearchQuery, Uuid } from './common';
import { MasterStatusFilter } from './parties';

export const ITEM_TYPES = [
  'RAW_MATERIAL',
  'COMPONENT',
  'FINISHED_GOOD',
  'CONSUMABLE',
  'SPARE',
  'SERVICE',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Everything about an item except its code, which never changes once created. */
const ItemFields = z.object({
  name: z.string().trim().min(2).max(200),
  description: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  itemType: z.enum(ITEM_TYPES),
  uom: z.string().trim().toUpperCase().min(2).max(10),
  hsnCode: z.string().regex(/^\d{4,8}$/, 'HSN code: 4–8 digits'),
  defaultSaleRate: z
    .union([RateString, z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});

export const CreateItemRequest = ItemFields.extend({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, 'Code: 2–30 letters, digits or hyphens'),
});
export type CreateItemRequest = z.input<typeof CreateItemRequest>;

/** Edit an item. The code is not editable; issued documents keep their own line snapshot. */
export const UpdateItemRequest = ItemFields.extend({
  itemId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type UpdateItemRequest = z.input<typeof UpdateItemRequest>;

/** Archive or reactivate an item. */
export const ItemStatusRequest = z.object({
  itemId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type ItemStatusRequest = z.input<typeof ItemStatusRequest>;

export const ListItemsQuery = SearchQuery.extend({
  itemType: z.enum(ITEM_TYPES).optional(),
  /** Only items that can be invoiced (finished goods, components, services). */
  saleable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  status: MasterStatusFilter,
});
export type ListItemsQuery = z.input<typeof ListItemsQuery>;

export interface ItemDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  itemType: ItemType;
  uom: string;
  hsnCode: string;
  /** GST rate effective today for the HSN code, or null if no rate is configured. */
  gstRatePercent: string | null;
  /** Verification status of that rate — demo rates are never presented as verified. */
  gstRateStatus: 'DEMO_UNVERIFIED' | 'SOURCE_FOUND' | 'CA_CONFIRMED' | null;
  defaultSaleRate: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  /** Stock on hand across warehouses, present only with inventory.stock.read. */
  stockOnHand: string | null;
  version: number;
}

export interface HsnCodeDto {
  code: string;
  description: string;
  currentRatePercent: string | null;
  rateStatus: ItemDto['gstRateStatus'];
}

export interface UomDto {
  code: string;
  name: string;
}

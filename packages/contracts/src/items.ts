import { z } from 'zod';
import { RateString, SearchQuery } from './common';

export const ITEM_TYPES = [
  'RAW_MATERIAL',
  'COMPONENT',
  'FINISHED_GOOD',
  'CONSUMABLE',
  'SPARE',
  'SERVICE',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const CreateItemRequest = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, 'Code: 2–30 letters, digits or hyphens'),
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
export type CreateItemRequest = z.input<typeof CreateItemRequest>;

export const ListItemsQuery = SearchQuery.extend({
  itemType: z.enum(ITEM_TYPES).optional(),
  /** Only items that can be invoiced (finished goods, components, services). */
  saleable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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

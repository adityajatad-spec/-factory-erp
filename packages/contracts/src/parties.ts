import { z } from 'zod';
import { Gstin, SearchQuery, StateCode, Uuid } from './common';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

/** Everything about a party except its code, which never changes once created. */
const PartyFields = z.object({
  name: z.string().trim().min(2).max(200),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
  gstin: z
    .union([Gstin, z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  stateCode: StateCode,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  postalCode: optionalText(10),
  contactName: optionalText(100),
  phone: optionalText(30),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  creditDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

const hasRole = (p: { isCustomer: boolean; isSupplier: boolean }) => p.isCustomer || p.isSupplier;
const ROLE_RULE = {
  message: 'A party must be a customer, a supplier or both',
  path: ['isCustomer'],
};
const gstinMatchesState = (p: { gstin: string | null; stateCode: string }) =>
  !p.gstin || p.gstin.startsWith(p.stateCode);
const GSTIN_RULE = { message: 'GSTIN state code must match the selected state', path: ['gstin'] };

export const CreatePartyRequest = PartyFields.extend({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,20}$/, 'Code: 2–20 letters, digits or hyphens'),
})
  .refine(hasRole, ROLE_RULE)
  .refine(gstinMatchesState, GSTIN_RULE);
export type CreatePartyRequest = z.input<typeof CreatePartyRequest>;

/** Edit a party. The code is not editable; issued documents keep their own snapshot. */
export const UpdatePartyRequest = PartyFields.extend({
  partyId: Uuid,
  expectedVersion: z.number().int().positive(),
})
  .refine(hasRole, ROLE_RULE)
  .refine(gstinMatchesState, GSTIN_RULE);
export type UpdatePartyRequest = z.input<typeof UpdatePartyRequest>;

/** Archive or reactivate a party (archiving never deletes; history keeps referring to it). */
export const PartyStatusRequest = z.object({
  partyId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type PartyStatusRequest = z.input<typeof PartyStatusRequest>;

/** Which records a master-data list shows. Defaults to the ones in use. */
export const MasterStatusFilter = z.enum(['active', 'archived', 'all']).default('active');

export const ListPartiesQuery = SearchQuery.extend({
  role: z.enum(['customer', 'supplier']).optional(),
  status: MasterStatusFilter,
});
export type ListPartiesQuery = z.input<typeof ListPartiesQuery>;

export interface PartyDto {
  id: string;
  code: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  gstin: string | null;
  stateCode: string;
  stateName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  creditDays: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  /** Receivable balance (debit − credit), present only with finance.receivables.read. */
  receivableBalance: string | null;
}

import { z } from 'zod';
import { Gstin, SearchQuery, StateCode } from './common';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

export const CreatePartyRequest = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/, 'Code: 2–20 letters, digits or hyphens'),
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
  })
  .refine((p) => p.isCustomer || p.isSupplier, {
    message: 'A party must be a customer, a supplier or both',
    path: ['isCustomer'],
  })
  .refine((p) => !p.gstin || p.gstin.startsWith(p.stateCode), {
    message: 'GSTIN state code must match the selected state',
    path: ['gstin'],
  });
export type CreatePartyRequest = z.input<typeof CreatePartyRequest>;

export const ListPartiesQuery = SearchQuery.extend({
  role: z.enum(['customer', 'supplier']).optional(),
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

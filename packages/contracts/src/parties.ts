import { z } from 'zod';
import { Gstin, SearchQuery, StateCode, Uuid } from './common';
import { restricted } from './data-class';

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

/**
 * Supplier bank details: RESTRICTED, under maker-checker. One person proposes new or changed
 * details; a different person approves (the previous details are superseded, never edited)
 * or rejects them. Command results only ever carry the masked number.
 */
export const BANK_ACCOUNT_STATUSES = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'SUPERSEDED',
] as const;
export type BankAccountStatus = (typeof BANK_ACCOUNT_STATUSES)[number];

export const ProposeBankAccountRequest = z.object({
  partyId: Uuid,
  accountHolderName: z.string().trim().min(1, 'Enter the account holder name').max(100),
  /** RESTRICTED: never hashed, logged, audited in full or sent to a model. */
  accountNumber: restricted(
    z
      .string()
      .trim()
      .regex(/^[0-9]{6,20}$/, 'Account number: digits only'),
  ),
  /** Structural check only [VERIFY R-25]. */
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like ABCD0123456'),
  bankName: optionalText(100),
  branch: optionalText(100),
  /** Why the details are new or changing (e.g. the supplier's letter). */
  changeReason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300),
});
export type ProposeBankAccountRequest = z.input<typeof ProposeBankAccountRequest>;

export const BankAccountDecisionRequest = z.object({
  bankAccountId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type BankAccountDecisionRequest = z.input<typeof BankAccountDecisionRequest>;

export const RejectBankAccountRequest = BankAccountDecisionRequest.extend({
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300),
});
export type RejectBankAccountRequest = z.input<typeof RejectBankAccountRequest>;

export const ListBankAccountsQuery = z.object({ partyId: Uuid });
export type ListBankAccountsQuery = z.input<typeof ListBankAccountsQuery>;

/** Bank details with the account number masked (e.g. "XXXXXX4321"). */
export interface BankAccountDto {
  id: string;
  partyId: string;
  status: BankAccountStatus;
  accountHolderName: string;
  accountNumberMasked: string;
  ifsc: string;
  bankName: string | null;
  branch: string | null;
  changeReason: string;
  requestedAt: string;
  /** The maker: a different user must approve. */
  requestedById: string;
  requestedByName: string;
  approvedAt: string | null;
  approvedByName: string | null;
  rejectedAt: string | null;
  rejectedByName: string | null;
  rejectionReason: string | null;
  supersededAt: string | null;
  version: number;
}

/** Only from the RESTRICTED bank-details query (permission party.bank.read, never the AI). */
export interface RestrictedBankAccountDto extends BankAccountDto {
  accountNumber: string;
}

import { z } from 'zod';
import { IsoDate, Uuid } from './common';

export const PAYMENT_MODES = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'OTHER'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Settlement status of an ISSUED invoice. Always DERIVED — never stored or edited — from
 * outstanding = grand total − Σ allocations − Σ issued credit notes:
 *  - UNPAID: something is outstanding and nothing has been paid (credit notes may exist);
 *  - PARTIALLY_PAID: something is outstanding and something has been paid;
 *  - PAID: nothing is outstanding and money was received (or the invoice was zero-value);
 *  - CREDITED: nothing is outstanding and no money was received — credit notes cleared it.
 */
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'CREDITED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Ageing buckets by days since invoice date (inclusive ranges; last is open-ended). */
export const AGEING_BUCKETS = [
  { key: 'd0_30', label: '0–30 days', minDays: 0, maxDays: 30 },
  { key: 'd31_60', label: '31–60 days', minDays: 31, maxDays: 60 },
  { key: 'd61_90', label: '61–90 days', minDays: 61, maxDays: 90 },
  { key: 'd90_plus', label: '90+ days', minDays: 91, maxDays: null },
] as const;
export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key'];

/** Strictly positive amount, max 2 decimals, as an exact decimal string. */
export const PositiveMoneyString = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'Expected an amount like "1234.50"')
  .refine((s) => /[1-9]/.test(s), 'Amount must be greater than zero');

export const AllocationInput = z.object({
  invoiceId: Uuid,
  amount: PositiveMoneyString,
});
export type AllocationInput = z.input<typeof AllocationInput>;

const uniqueInvoices = (allocations: ReadonlyArray<{ invoiceId: string }>) =>
  new Set(allocations.map((a) => a.invoiceId)).size === allocations.length;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const RecordReceiptRequest = z.object({
  customerId: Uuid,
  receiptDate: IsoDate,
  amount: PositiveMoneyString,
  paymentMode: z.enum(PAYMENT_MODES),
  /** Bank / UPI transaction reference or cheque number. */
  reference: optionalText(100),
  notes: optionalText(500),
  allocations: z
    .array(AllocationInput)
    .max(200)
    .default([])
    .refine(uniqueInvoices, 'Each invoice may appear only once'),
});
export type RecordReceiptRequest = z.input<typeof RecordReceiptRequest>;

export const AllocateReceiptRequest = z.object({
  receiptId: Uuid,
  allocations: z
    .array(AllocationInput)
    .min(1, 'Allocate to at least one invoice')
    .max(200)
    .refine(uniqueInvoices, 'Each invoice may appear only once'),
});
export type AllocateReceiptRequest = z.input<typeof AllocateReceiptRequest>;

export const ListReceiptsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  customerId: Uuid.optional(),
  onlyUnallocated: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReceiptsQuery = z.input<typeof ListReceiptsQuery>;

export const OpenInvoicesQuery = z.object({ customerId: Uuid });
export type OpenInvoicesQuery = z.input<typeof OpenInvoicesQuery>;

export interface ReceiptListItemDto {
  id: string;
  receiptNumber: string;
  receiptDate: string;
  customerId: string;
  customerName: string;
  paymentMode: PaymentMode;
  reference: string | null;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
}

export interface ReceiptAllocationDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  allocatedAt: string;
  allocatedByName: string | null;
}

export interface ReceiptDto extends ReceiptListItemDto {
  notes: string | null;
  createdAt: string;
  createdByName: string | null;
  allocations: ReceiptAllocationDto[];
}

/** An issued invoice with money still owed on it. */
export interface OpenInvoiceDto {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  grandTotal: string;
  paidAmount: string;
  /** Σ issued credit notes against the invoice. */
  creditedAmount: string;
  /** grand total − paid − credited. */
  outstandingAmount: string;
  ageDays: number;
}

/** A receipt applied to an invoice, as seen from the invoice. */
export interface InvoicePaymentDto {
  allocationId: string;
  receiptId: string;
  receiptNumber: string;
  receiptDate: string;
  paymentMode: PaymentMode;
  amount: string;
}

export type AgeingAmounts = Record<AgeingBucketKey, string>;

export interface CustomerReceivableDto {
  customerId: string;
  code: string;
  name: string;
  /** Σ issued invoices, net of cancellations (party ledger). */
  invoicedAmount: string;
  /** Σ issued credit notes (party ledger). */
  creditedAmount: string;
  /** Σ receipts (party ledger). */
  receivedAmount: string;
  /**
   * invoiced − credited − received (= the party ledger balance). Negative means the customer
   * holds a credit with us.
   */
  balance: string;
  /** Bill-wise: Σ invoice outstanding (grand total − allocations − credit notes). */
  outstandingAmount: string;
  /** Receipt money not yet allocated to any invoice (on-account / advance). */
  unallocatedAmount: string;
  openInvoiceCount: number;
  ageing: AgeingAmounts;
}

export interface ReceivablesSummaryDto {
  asOf: string;
  totals: Omit<CustomerReceivableDto, 'customerId' | 'code' | 'name'>;
  customers: CustomerReceivableDto[];
}

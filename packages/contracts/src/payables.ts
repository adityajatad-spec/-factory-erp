import { z } from 'zod';
import { IsoDate, Uuid } from './common';
import { PAYMENT_MODES, PositiveMoneyString, type PaymentMode } from './receivables';

/**
 * Supplier payments (Slice 1), the mirror of customer receipts with maker-checker:
 *   PENDING_APPROVAL → APPROVED (by a different person: numbered, reduces what we owe,
 *                                settles the proposed invoices)
 *   PENDING_APPROVAL → REJECTED (with a reason)
 * Money that settles no invoice stays on account (an advance to the supplier) until it is
 * allocated with an explicit command.
 */
export const SUPPLIER_PAYMENT_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const SupplierAllocationInput = z.object({
  purchaseInvoiceId: Uuid,
  amount: PositiveMoneyString,
});
export type SupplierAllocationInput = z.input<typeof SupplierAllocationInput>;

const uniqueInvoices = (allocations: ReadonlyArray<{ purchaseInvoiceId: string }>) =>
  new Set(allocations.map((a) => a.purchaseInvoiceId)).size === allocations.length;

export const RequestSupplierPaymentRequest = z.object({
  supplierId: Uuid,
  paymentDate: IsoDate,
  amount: PositiveMoneyString,
  paymentMode: z.enum(PAYMENT_MODES),
  /** Bank / UPI transaction reference or cheque number. */
  reference: optionalText(100),
  notes: optionalText(500),
  /** Bills this payment should settle; applied when it is approved. */
  allocations: z
    .array(SupplierAllocationInput)
    .max(200)
    .default([])
    .refine(uniqueInvoices, 'Each invoice may appear only once'),
});
export type RequestSupplierPaymentRequest = z.input<typeof RequestSupplierPaymentRequest>;

export const SupplierPaymentVersionRequest = z.object({
  paymentId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type SupplierPaymentVersionRequest = z.input<typeof SupplierPaymentVersionRequest>;

export const RejectSupplierPaymentRequest = SupplierPaymentVersionRequest.extend({
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500),
});
export type RejectSupplierPaymentRequest = z.input<typeof RejectSupplierPaymentRequest>;

export const AllocateSupplierPaymentRequest = z.object({
  paymentId: Uuid,
  allocations: z
    .array(SupplierAllocationInput)
    .min(1, 'Allocate to at least one invoice')
    .max(200)
    .refine(uniqueInvoices, 'Each invoice may appear only once'),
});
export type AllocateSupplierPaymentRequest = z.input<typeof AllocateSupplierPaymentRequest>;

export const ListSupplierPaymentsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: Uuid.optional(),
  status: z.enum(SUPPLIER_PAYMENT_STATUSES).optional(),
  /** Approved payments with money not yet allocated to invoices (on account). */
  onlyUnallocated: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSupplierPaymentsQuery = z.input<typeof ListSupplierPaymentsQuery>;

export const OpenPayablesQuery = z.object({
  supplierId: Uuid.optional(),
  /** Only bills past their due date. */
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Only bills falling due in the next N days, today included (7 = "this week"). */
  dueWithinDays: z.coerce.number().int().min(1).max(366).optional(),
});
export type OpenPayablesQuery = z.input<typeof OpenPayablesQuery>;

/** A posted purchase invoice with money still owed (bill-wise, derived). */
export interface OpenPayableDto {
  purchaseInvoiceId: string;
  invoiceNumber: string;
  supplierInvoiceNumber: string;
  supplierId: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string;
  grandTotal: string;
  paidAmount: string;
  outstandingAmount: string;
  /** Days past the due date (0 if not yet due). */
  daysOverdue: number;
  isOverdue: boolean;
}

export interface PayableAmounts {
  /** Σ posted purchase invoices (payable ledger credits). */
  billedAmount: string;
  /** Σ approved payments (payable ledger debits). */
  paidAmount: string;
  /** What we owe: billed − paid, from the ledger. Negative = we have paid in advance. */
  balance: string;
  /** Σ bill-wise outstanding on posted invoices. */
  outstandingAmount: string;
  /** Approved payments not yet allocated to an invoice (advances). */
  unallocatedAmount: string;
  overdueAmount: string;
  /** Outstanding on bills due in the next 7 days, today included. */
  dueThisWeekAmount: string;
  /** Requested payments still awaiting approval (not yet deducted). */
  pendingApprovalAmount: string;
  openInvoiceCount: number;
  overdueInvoiceCount: number;
}

export interface SupplierPayableDto extends PayableAmounts {
  supplierId: string;
  code: string;
  name: string;
}

/** Reconciles by construction: balance = outstanding − unallocated. */
export interface PayablesSummaryDto {
  asOf: string;
  totals: PayableAmounts;
  suppliers: SupplierPayableDto[];
}

export interface SupplierPaymentListItemDto {
  id: string;
  status: SupplierPaymentStatus;
  /** Given at approval. */
  paymentNumber: string | null;
  paymentDate: string;
  supplierId: string;
  supplierName: string;
  amount: string;
  paymentMode: PaymentMode;
  reference: string | null;
  allocatedAmount: string;
  /** Approved payments only; zero otherwise. */
  unallocatedAmount: string;
  /** Who recorded it (the maker); a different user must approve it. */
  requestedById: string;
  requestedByName: string;
  approvedByName: string | null;
}

export interface SupplierPaymentDto extends SupplierPaymentListItemDto {
  notes: string | null;
  proposedAllocations: Array<{
    purchaseInvoiceId: string;
    invoiceNumber: string | null;
    supplierInvoiceNumber: string;
    amount: string;
  }>;
  allocations: Array<{
    id: string;
    purchaseInvoiceId: string;
    invoiceNumber: string;
    supplierInvoiceNumber: string;
    amount: string;
    allocatedAt: string;
    allocatedByName: string | null;
  }>;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectedByName: string | null;
  rejectionReason: string | null;
  version: number;
}

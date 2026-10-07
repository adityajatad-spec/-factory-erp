import { z } from 'zod';
import {
  IsoDate,
  PercentString,
  QtyString,
  RateString,
  SearchQuery,
  StateCode,
  Uuid,
} from './common';
import type { CreditNoteReason, CreditNoteStatus } from './credit-notes';
import { PAYMENT_STATUSES, type InvoicePaymentDto, type PaymentStatus } from './receivables';

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const InvoiceLineInput = z.object({
  itemId: Uuid,
  /** Optional override of the item name printed on the invoice. */
  description: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  quantity: QtyString,
  unitRate: RateString,
  discountPercent: PercentString.default('0'),
});

export const InvoiceDraftBody = z.object({
  customerId: Uuid,
  invoiceDate: IsoDate,
  /** Defaults to the customer's state when omitted. */
  placeOfSupplyStateCode: StateCode.optional(),
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  lines: z.array(InvoiceLineInput).min(1, 'Add at least one line').max(200),
});
export type InvoiceDraftBody = z.input<typeof InvoiceDraftBody>;

export const CreateInvoiceDraftRequest = InvoiceDraftBody;
export type CreateInvoiceDraftRequest = z.input<typeof CreateInvoiceDraftRequest>;

export const UpdateInvoiceDraftRequest = InvoiceDraftBody.extend({
  invoiceId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type UpdateInvoiceDraftRequest = z.input<typeof UpdateInvoiceDraftRequest>;

export const IssueInvoiceRequest = z.object({
  invoiceId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type IssueInvoiceRequest = z.input<typeof IssueInvoiceRequest>;

export const DeleteInvoiceDraftRequest = IssueInvoiceRequest;
export type DeleteInvoiceDraftRequest = z.input<typeof DeleteInvoiceDraftRequest>;

/** Why a document is being corrected — required, recorded forever in the document and audit. */
export const CorrectionReason = z
  .string()
  .trim()
  .min(3, 'Give a reason (at least 3 characters)')
  .max(500);

/**
 * Cancel an ISSUED invoice that nothing has settled (no payments, no credit notes). The
 * invoice, its number and its values are kept; a reversing entry clears the customer balance.
 */
export const CancelInvoiceRequest = z.object({
  invoiceId: Uuid,
  expectedVersion: z.number().int().positive(),
  reason: CorrectionReason,
});
export type CancelInvoiceRequest = z.input<typeof CancelInvoiceRequest>;

export const ListInvoicesQuery = SearchQuery.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  /** Settlement filter; implies issued invoices. */
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  customerId: Uuid.optional(),
});
export type ListInvoicesQuery = z.input<typeof ListInvoicesQuery>;

export interface InvoiceLineDto {
  lineNo: number;
  itemId: string;
  itemCode: string;
  description: string;
  hsnCode: string;
  uom: string;
  quantity: string;
  unitRate: string;
  discountPercent: string;
  gstRatePercent: string;
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstRatePercent: string;
  cgstAmount: string;
  sgstRatePercent: string;
  sgstAmount: string;
  igstRatePercent: string;
  igstAmount: string;
  lineTotal: string;
}

/** An invoice line plus how much of it issued credit notes have already credited. */
export interface InvoiceDetailLineDto extends InvoiceLineDto {
  creditedQuantity: string;
  creditedTaxableAmount: string;
}

/** A credit note against the invoice, as seen from the invoice. */
export interface InvoiceCreditNoteDto {
  creditNoteId: string;
  creditNoteNumber: string | null;
  creditNoteDate: string;
  status: CreditNoteStatus;
  reasonCode: CreditNoteReason;
  grandTotal: string;
}

export interface InvoiceCancellationDto {
  cancelledAt: string;
  cancelledByName: string | null;
  reason: string;
}

export interface InvoiceTotalsDto {
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
  roundOff: string;
  grandTotal: string;
}

export interface InvoiceListItemDto {
  id: string;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string;
  customerId: string;
  customerName: string;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  grandTotal: string;
  issuedAt: string | null;
  hasPdf: boolean;
  /** Derived from allocations and credit notes; null unless ISSUED. */
  paymentStatus: PaymentStatus | null;
  /** Σ allocations to this invoice; "0.00" for drafts. */
  paidAmount: string;
  /** Σ issued credit notes against this invoice; "0.00" when there are none. */
  creditedAmount: string;
  /** grand total − paid − credited; null unless ISSUED (drafts and cancelled invoices owe nothing). */
  outstandingAmount: string | null;
}

export interface InvoiceDto extends Omit<InvoiceListItemDto, 'hasPdf'> {
  version: number;
  customerGstin: string | null;
  supplierStateCode: string;
  /** Grand-total rounding stored with the invoice's GST policy (credit notes inherit it). */
  invoiceRounding: 'NEAREST_RUPEE' | 'NONE';
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName: string;
  notes: string | null;
  totals: InvoiceTotalsDto;
  amountInWords: string;
  calcEngineVersion: string;
  lines: InvoiceDetailLineDto[];
  pdfDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  payments: InvoicePaymentDto[];
  /** Drafts and issued credit notes against this invoice, oldest first. */
  creditNotes: InvoiceCreditNoteDto[];
  /** Present only for CANCELLED invoices. */
  cancellation: InvoiceCancellationDto | null;
}

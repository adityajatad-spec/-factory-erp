import { z } from 'zod';
import { IsoDate, QtyString, RateString, SearchQuery, Uuid } from './common';
import { CorrectionReason, type InvoiceLineDto, type InvoiceTotalsDto } from './sales';

/**
 * Credit notes: a separate financial document that reduces what a customer owes on ONE issued
 * invoice (returns, post-sale discounts, price corrections). Never a negative invoice.
 * Lifecycle DRAFT → ISSUED; issued credit notes are immutable.
 */
export const CREDIT_NOTE_STATUSES = ['DRAFT', 'ISSUED'] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

/** [VERIFY R-03] Grounds on which a GST credit note may be issued must be confirmed by the CA. */
export const CREDIT_NOTE_REASONS = [
  'SALES_RETURN',
  'POST_SALE_DISCOUNT',
  'PRICE_CORRECTION',
  'DEFICIENT_SUPPLY',
  'OTHER',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

/**
 * Credit part of one invoice line: quantity × unit rate, with that line's own discount % and
 * GST rate. For a return use the original rate; for a price reduction use the reduction per unit.
 */
export const CreditNoteLineInput = z.object({
  invoiceLineNo: z.number().int().positive(),
  quantity: QtyString,
  unitRate: RateString,
});
export type CreditNoteLineInput = z.input<typeof CreditNoteLineInput>;

const optionalNotes = z
  .string()
  .trim()
  .max(1000)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

export const CreditNoteDraftBody = z.object({
  creditNoteDate: IsoDate,
  reasonCode: z.enum(CREDIT_NOTE_REASONS),
  reason: CorrectionReason,
  notes: optionalNotes,
  lines: z
    .array(CreditNoteLineInput)
    .min(1, 'Credit at least one invoice line')
    .max(200)
    .refine(
      (lines) => new Set(lines.map((l) => l.invoiceLineNo)).size === lines.length,
      'Each invoice line may appear only once',
    ),
});

/**
 * The customer is stated explicitly and must match the invoice: it guards against crediting
 * the wrong customer's invoice (by a person or, later, the AI copilot).
 */
export const CreateCreditNoteDraftRequest = CreditNoteDraftBody.extend({
  invoiceId: Uuid,
  customerId: Uuid,
});
export type CreateCreditNoteDraftRequest = z.input<typeof CreateCreditNoteDraftRequest>;

/** The invoice of a draft cannot change — delete the draft and start again instead. */
export const UpdateCreditNoteDraftRequest = CreditNoteDraftBody.extend({
  creditNoteId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type UpdateCreditNoteDraftRequest = z.input<typeof UpdateCreditNoteDraftRequest>;

export const IssueCreditNoteRequest = z.object({
  creditNoteId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type IssueCreditNoteRequest = z.input<typeof IssueCreditNoteRequest>;

export const DeleteCreditNoteDraftRequest = IssueCreditNoteRequest;
export type DeleteCreditNoteDraftRequest = z.input<typeof DeleteCreditNoteDraftRequest>;

export const ListCreditNotesQuery = SearchQuery.extend({
  status: z.enum(CREDIT_NOTE_STATUSES).optional(),
  customerId: Uuid.optional(),
  invoiceId: Uuid.optional(),
});
export type ListCreditNotesQuery = z.input<typeof ListCreditNotesQuery>;

export interface CreditNoteListItemDto {
  id: string;
  status: CreditNoteStatus;
  creditNoteNumber: string | null;
  creditNoteDate: string;
  customerId: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string;
  reasonCode: CreditNoteReason;
  grandTotal: string;
  issuedAt: string | null;
  hasPdf: boolean;
}

export interface CreditNoteLineDto extends InvoiceLineDto {
  /** The line of the original invoice this line credits. */
  invoiceLineNo: number;
}

export interface CreditNoteDto extends Omit<CreditNoteListItemDto, 'hasPdf'> {
  version: number;
  invoiceDate: string;
  customerGstin: string | null;
  reason: string;
  notes: string | null;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName: string;
  totals: InvoiceTotalsDto;
  amountInWords: string;
  calcEngineVersion: string;
  lines: CreditNoteLineDto[];
  pdfDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string> = {
  SALES_RETURN: 'Goods returned',
  POST_SALE_DISCOUNT: 'Post-sale discount',
  PRICE_CORRECTION: 'Price correction (excess charged)',
  DEFICIENT_SUPPLY: 'Deficient or short supply',
  OTHER: 'Other',
};

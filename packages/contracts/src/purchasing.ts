import { z } from 'zod';
import { IsoDate, PercentString, QtyString, RateString, SearchQuery, Uuid } from './common';

/**
 * Purchase orders (Slice 1). Lifecycle:
 *   DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED
 *   APPROVED | PARTIALLY_RECEIVED → CLOSED (short-closed, with a reason)
 *   DRAFT | APPROVED with nothing received → CANCELLED (with a reason)
 * Only drafts can be edited; approval numbers the order and freezes it.
 */
export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const Reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

export const PurchaseLineInput = z.object({
  itemId: Uuid,
  description: optionalText(300),
  quantity: QtyString,
  unitRate: RateString,
  discountPercent: PercentString.default('0'),
});
export type PurchaseLineInput = z.input<typeof PurchaseLineInput>;

const PurchaseOrderBody = z.object({
  supplierId: Uuid,
  /** Where the goods are to be delivered (and received into stock). */
  warehouseId: Uuid,
  poDate: IsoDate,
  expectedDate: IsoDate.nullable()
    .optional()
    .transform((v) => v ?? null),
  notes: optionalText(1000),
  lines: z.array(PurchaseLineInput).min(1, 'Add at least one line').max(200),
});
const expectedAfterPoDate = (b: { poDate: string; expectedDate: string | null }) =>
  !b.expectedDate || b.expectedDate >= b.poDate;
const EXPECTED_RULE = {
  message: 'Expected delivery cannot be before the order date',
  path: ['expectedDate'],
};

export const CreatePurchaseOrderRequest = PurchaseOrderBody.refine(
  expectedAfterPoDate,
  EXPECTED_RULE,
);
export type CreatePurchaseOrderRequest = z.input<typeof CreatePurchaseOrderRequest>;

export const UpdatePurchaseOrderRequest = PurchaseOrderBody.extend({
  orderId: Uuid,
  expectedVersion: z.number().int().positive(),
}).refine(expectedAfterPoDate, EXPECTED_RULE);
export type UpdatePurchaseOrderRequest = z.input<typeof UpdatePurchaseOrderRequest>;

/** Approve or delete a draft. */
export const PurchaseOrderVersionRequest = z.object({
  orderId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type PurchaseOrderVersionRequest = z.input<typeof PurchaseOrderVersionRequest>;

/** Cancel (nothing received yet) or short-close (the rest will not come). */
export const PurchaseOrderReasonRequest = PurchaseOrderVersionRequest.extend({ reason: Reason });
export type PurchaseOrderReasonRequest = z.input<typeof PurchaseOrderReasonRequest>;

export const ListPurchaseOrdersQuery = SearchQuery.extend({
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  supplierId: Uuid.optional(),
  /** Approved or partially received: still expecting goods. */
  open: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Open and past the expected delivery date. */
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListPurchaseOrdersQuery = z.input<typeof ListPurchaseOrdersQuery>;

export interface PurchaseOrderLineDto {
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
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
  /** Derived from goods receipts: accepted into stock so far. */
  acceptedQuantity: string;
  rejectedQuantity: string;
  remainingQuantity: string;
  /** Derived from posted purchase invoices. */
  invoicedQuantity: string;
}

export interface PurchaseOrderListItemDto {
  id: string;
  status: PurchaseOrderStatus;
  poNumber: string | null;
  poDate: string;
  expectedDate: string | null;
  supplierId: string;
  supplierName: string;
  warehouseCode: string;
  grandTotal: string;
  /** Open and past its expected delivery date (computed by the server). */
  isOverdue: boolean;
}

export interface PurchaseOrderDto extends PurchaseOrderListItemDto {
  supplierCode: string;
  supplierGstin: string | null;
  warehouseId: string;
  warehouseName: string;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  notes: string | null;
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
  roundOff: string;
  amountInWords: string;
  lines: PurchaseOrderLineDto[];
  approvedAt: string | null;
  approvedByName: string | null;
  closedAt: string | null;
  closeReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  pdfDocumentId: string | null;
  receipts: Array<{ id: string; grnNumber: string; receiptDate: string }>;
  invoices: Array<{
    id: string;
    invoiceNumber: string | null;
    supplierInvoiceNumber: string;
    status: string;
  }>;
  version: number;
}

/**
 * Goods receipt (GRN): what physically arrived against an approved order. Accepted quantity
 * enters stock; rejected quantity (with a reason) goes back to the supplier and does not use up
 * the order. Over-receipt is not allowed in V1.
 */
export const RecordGoodsReceiptRequest = z.object({
  orderId: Uuid,
  receiptDate: IsoDate,
  /** The supplier's delivery challan or note number. */
  supplierReference: optionalText(100),
  notes: optionalText(500),
  lines: z
    .array(
      z.object({
        orderLineNo: z.number().int().positive(),
        acceptedQuantity: z
          .string()
          .regex(/^\d{1,12}(\.\d{1,3})?$/, 'Expected a quantity with at most 3 decimals'),
        rejectedQuantity: z
          .string()
          .regex(/^\d{1,12}(\.\d{1,3})?$/, 'Expected a quantity with at most 3 decimals')
          .default('0'),
        rejectionReason: optionalText(300),
      }),
    )
    .min(1, 'Receive at least one line')
    .max(200)
    .refine(
      (ls) => new Set(ls.map((l) => l.orderLineNo)).size === ls.length,
      'Each order line only once',
    ),
});
export type RecordGoodsReceiptRequest = z.input<typeof RecordGoodsReceiptRequest>;

export const ListGoodsReceiptsQuery = SearchQuery.extend({
  orderId: Uuid.optional(),
  supplierId: Uuid.optional(),
});
export type ListGoodsReceiptsQuery = z.input<typeof ListGoodsReceiptsQuery>;

export interface GoodsReceiptLineDto {
  lineNo: number;
  orderLineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  rejectionReason: string | null;
}

export interface GoodsReceiptListItemDto {
  id: string;
  grnNumber: string;
  receiptDate: string;
  orderId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  warehouseCode: string;
  supplierReference: string | null;
}

export interface GoodsReceiptDto extends GoodsReceiptListItemDto {
  warehouseId: string;
  notes: string | null;
  lines: GoodsReceiptLineDto[];
  createdAt: string;
  createdByName: string;
}

/**
 * Purchase invoice: the supplier's bill, entered by us. DRAFT → POSTED; a posted invoice is
 * immutable and owed to the supplier. Two explicit paths:
 *  - PO-based (`orderId` set): lines bill order lines; posting runs the three-way match
 *    (order vs goods received vs invoice);
 *  - direct (`orderId` null): services or one-off purchases; only the bill total is checked.
 * Tax is recomputed by the shared GST engine from the billed rates; the supplier's printed
 * total is kept and compared.
 */
export const PURCHASE_INVOICE_STATUSES = ['DRAFT', 'POSTED'] as const;
export type PurchaseInvoiceStatus = (typeof PURCHASE_INVOICE_STATUSES)[number];

/**
 * NOT_APPLICABLE: direct invoice with nothing to flag. MATCHED: PO-based with no findings.
 * ACCEPTED_WITH_DIFFERENCES: posted despite findings, by someone allowed to, with a reason.
 */
export const MATCH_STATUSES = ['NOT_APPLICABLE', 'MATCHED', 'ACCEPTED_WITH_DIFFERENCES'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_FINDING_CODES = [
  'NOT_ON_ORDER',
  'ITEM_MISMATCH',
  'QTY_EXCEEDS_RECEIVED',
  'PRICE_ABOVE_ORDER',
  'TOTAL_MISMATCH',
] as const;
export type MatchFindingCode = (typeof MATCH_FINDING_CODES)[number];

/** One deterministic difference found by the three-way match. */
export interface MatchFinding {
  code: MatchFindingCode;
  invoiceLineNo: number | null;
  orderLineNo: number | null;
  message: string;
  /** What the order / receipts / our computation says. */
  expected: string | null;
  /** What the invoice says. */
  actual: string | null;
}

/** Bill-wise settlement of a posted purchase invoice (derived, never stored). */
export const PAYABLE_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];

const NonNegativeMoneyString = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'Expected an amount like "1234.50"');

export const PurchaseInvoiceLineInput = PurchaseLineInput.extend({
  /** The order line this bills. Leave empty for a charge that is not on the order. */
  orderLineNo: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
export type PurchaseInvoiceLineInput = z.input<typeof PurchaseInvoiceLineInput>;

const PurchaseInvoiceBody = z.object({
  supplierId: Uuid,
  /** The purchase order this bill is for, or null for a direct (non-PO) purchase. */
  orderId: Uuid.nullable(),
  /** The delivery (GRN) this bill covers, if the supplier names one. */
  goodsReceiptId: Uuid.nullable()
    .optional()
    .transform((v) => v ?? null),
  /** As printed on the supplier's bill. */
  supplierInvoiceNumber: z.string().trim().min(1, 'Enter the supplier invoice number').max(30),
  invoiceDate: IsoDate,
  /** The grand total printed on the bill; compared with ours when posting. */
  supplierStatedTotal: NonNegativeMoneyString,
  notes: optionalText(1000),
  lines: z.array(PurchaseInvoiceLineInput).min(1, 'Add at least one line').max(200),
});

function checkInvoicePath(
  b: z.output<typeof PurchaseInvoiceBody>,
  ctx: z.RefinementCtx<z.output<typeof PurchaseInvoiceBody>>,
) {
  if (b.orderId === null) {
    if (b.goodsReceiptId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['goodsReceiptId'],
        message: 'A goods receipt can only be named on a PO-based invoice',
      });
    }
    b.lines.forEach((l, i) => {
      if (l.orderLineNo !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'orderLineNo'],
          message: 'A direct invoice does not bill order lines',
        });
      }
    });
  }
  const billed = b.lines.flatMap((l) => (l.orderLineNo === null ? [] : [l.orderLineNo]));
  if (new Set(billed).size !== billed.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Each order line only once' });
  }
}

export const CreatePurchaseInvoiceRequest = PurchaseInvoiceBody.superRefine(checkInvoicePath);
export type CreatePurchaseInvoiceRequest = z.input<typeof CreatePurchaseInvoiceRequest>;

export const UpdatePurchaseInvoiceRequest = PurchaseInvoiceBody.extend({
  invoiceId: Uuid,
  expectedVersion: z.number().int().positive(),
}).superRefine(checkInvoicePath);
export type UpdatePurchaseInvoiceRequest = z.input<typeof UpdatePurchaseInvoiceRequest>;

export const PurchaseInvoiceVersionRequest = z.object({
  invoiceId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type PurchaseInvoiceVersionRequest = z.input<typeof PurchaseInvoiceVersionRequest>;

export const PostPurchaseInvoiceRequest = PurchaseInvoiceVersionRequest.extend({
  /** Needed (with the override permission) to post an invoice that does not match. */
  matchOverrideReason: optionalText(500),
});
export type PostPurchaseInvoiceRequest = z.input<typeof PostPurchaseInvoiceRequest>;

export const ListPurchaseInvoicesQuery = SearchQuery.extend({
  status: z.enum(PURCHASE_INVOICE_STATUSES).optional(),
  supplierId: Uuid.optional(),
  orderId: Uuid.optional(),
});
export type ListPurchaseInvoicesQuery = z.input<typeof ListPurchaseInvoicesQuery>;

export interface PurchaseInvoiceLineDto {
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
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
  orderLineNo: number | null;
}

export interface PurchaseInvoiceListItemDto {
  id: string;
  status: PurchaseInvoiceStatus;
  /** Our voucher number (given at posting). */
  invoiceNumber: string | null;
  postingDate: string | null;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  supplierId: string;
  supplierName: string;
  orderId: string | null;
  poNumber: string | null;
  grandTotal: string;
  matchStatus: MatchStatus | null;
  /** Posted invoices only (zero for drafts). */
  paidAmount: string;
  outstandingAmount: string;
  payableStatus: PayableStatus | null;
  /** Posted, unpaid and past its due date (computed by the server). */
  isOverdue: boolean;
}

export interface PurchaseInvoiceDto extends PurchaseInvoiceListItemDto {
  basis: 'PURCHASE_ORDER' | 'DIRECT';
  supplierCode: string;
  supplierGstin: string | null;
  goodsReceiptId: string | null;
  grnNumber: string | null;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  notes: string | null;
  grossAmount: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
  roundOff: string;
  amountInWords: string;
  supplierStatedTotal: string;
  /** Stored at posting; for a draft, run `purchase.invoices.match` to see the current result. */
  matchFindings: MatchFinding[];
  matchOverrideReason: string | null;
  lines: PurchaseInvoiceLineDto[];
  postedAt: string | null;
  postedByName: string | null;
  payments: Array<{
    paymentId: string;
    paymentNumber: string | null;
    paymentDate: string;
    amount: string;
  }>;
  version: number;
}

/** The three-way match of one invoice, as it stands now (draft) or as posted. */
export interface PurchaseInvoiceMatchDto {
  invoiceId: string;
  status: PurchaseInvoiceStatus;
  basis: 'PURCHASE_ORDER' | 'DIRECT';
  computedTotal: string;
  supplierStatedTotal: string;
  tolerances: { qtyPercent: string; pricePercent: string; totalAmount: string };
  findings: MatchFinding[];
  /** What posting would record (draft) or recorded (posted). */
  matchStatus: MatchStatus;
}

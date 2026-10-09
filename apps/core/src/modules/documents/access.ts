import { PERMISSIONS, type Permission } from '@factory-erp/contracts';
import type { DbExecutor } from '../../db/database';
import type { DocumentKind } from './store';

/**
 * Who may read a stored document is decided by the business record it belongs to, never by a
 * blanket "documents" permission (Slice 0). Each kind names the permission that reads its
 * owning record and how to find that record. A kind without a rule here — a future HR or
 * salary document, or a generic upload — cannot be read by anyone until it gets one.
 */
export interface DocumentAccessRule {
  /** The permission that reads the owning record (e.g. an invoice PDF → read invoices). */
  permission: Permission;
  /** The owning record exists in this company and points at this document. */
  attached(db: DbExecutor, companyId: string, documentId: string): Promise<boolean>;
}

export const DOCUMENT_ACCESS: Readonly<Record<DocumentKind, DocumentAccessRule>> = {
  SALES_INVOICE_PDF: {
    permission: PERMISSIONS.salesInvoiceRead,
    attached: async (db, companyId, documentId) =>
      !!(await db
        .selectFrom('sales.invoices')
        .select('id')
        .where('companyId', '=', companyId)
        .where('pdfDocumentId', '=', documentId)
        .executeTakeFirst()),
  },
  // Credit notes are read with the invoice permission (they are listed and shown there).
  SALES_CREDIT_NOTE_PDF: {
    permission: PERMISSIONS.salesInvoiceRead,
    attached: async (db, companyId, documentId) =>
      !!(await db
        .selectFrom('sales.creditNotes')
        .select('id')
        .where('companyId', '=', companyId)
        .where('pdfDocumentId', '=', documentId)
        .executeTakeFirst()),
  },
  // A purchase order PDF is read by whoever may read purchase orders.
  PURCHASE_ORDER_PDF: {
    permission: PERMISSIONS.purchaseOrderRead,
    attached: async (db, companyId, documentId) =>
      !!(await db
        .selectFrom('purchase.orders')
        .select('id')
        .where('companyId', '=', companyId)
        .where('pdfDocumentId', '=', documentId)
        .executeTakeFirst()),
  },
};

/** Kinds the database allows that deliberately have no readers yet, and why. */
export const UNREADABLE_KINDS: Readonly<Record<string, string>> = {
  UPLOAD: 'generic uploads get entity-attached access with document intake (Slice 3)',
};

export function accessRuleFor(kind: string): DocumentAccessRule | undefined {
  return Object.hasOwn(DOCUMENT_ACCESS, kind) ? DOCUMENT_ACCESS[kind as DocumentKind] : undefined;
}

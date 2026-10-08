import { z } from 'zod';
import { systemActor } from '../../../platform/actor';
import { writeAudit } from '../../../platform/audit';
import type { BlobStore, StoredBlob } from '../../../platform/blob-store';
import { defineOutboxHandler, type OutboxHandler } from '../../../platform/outbox';
import type { PdfRenderer } from '../../../platform/pdf';
import { recordDocument } from '../../documents';
import {
  buildCreditNotePrintModel,
  buildInvoicePrintModel,
  type SalesPrintModel,
} from './print-model';
import { renderSalesDocumentHtml } from './template';

interface PdfDeps {
  blobStore: BlobStore;
  renderer: PdfRenderer;
}

/** A rendered, stored PDF waiting to be attached to its document. */
interface RenderedPdf {
  blob: StoredBlob;
  filename: string;
}

/** Render → content-addressed blob. No transaction, no lock: this is the slow part. */
async function renderToBlob(deps: PdfDeps, model: SalesPrintModel): Promise<RenderedPdf> {
  const pdf = await deps.renderer.render(renderSalesDocumentHtml(model));
  return {
    blob: await deps.blobStore.put(pdf),
    filename: `${model.documentNumber.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`,
  };
}

const InvoicePayload = z.object({ invoiceId: z.uuid(), companyId: z.uuid() });

/**
 * Outbox handler for `sales.invoice.issued`: render, store and attach the invoice PDF.
 *
 * The persisted invoice is the record; its PDF is a side effect. Rendering (seconds, in Chrome)
 * happens in `prepare`, with no row lock, reading the issued invoice — which can no longer
 * change. `apply` then locks the invoice only long enough to attach the document, so payments,
 * credit notes and cancellation on the same invoice are never held up by a render.
 * Idempotent: an invoice that already has a PDF is left untouched (the SQL guard forbids
 * replacing one), and a duplicate render is harmless because blobs are content-addressed.
 */
export function invoicePdfHandler(deps: PdfDeps): OutboxHandler {
  return defineOutboxHandler<RenderedPdf | null>({
    async prepare({ db, event }) {
      const { invoiceId, companyId } = InvoicePayload.parse(event.payload);
      const inv = await db
        .selectFrom('sales.invoices')
        .select(['status', 'invoiceNumber', 'pdfDocumentId'])
        .where('id', '=', invoiceId)
        .where('companyId', '=', companyId)
        .executeTakeFirst();
      if (!inv?.invoiceNumber || inv.status === 'DRAFT')
        throw new Error(`Invoice ${invoiceId} is not issued`);
      if (inv.pdfDocumentId) return null;
      return renderToBlob(deps, await buildInvoicePrintModel(db, invoiceId));
    },
    async apply({ tx, event, now, prepared }) {
      if (!prepared) return;
      const { invoiceId, companyId } = InvoicePayload.parse(event.payload);
      const inv = await tx
        .selectFrom('sales.invoices')
        .select('pdfDocumentId')
        .where('id', '=', invoiceId)
        .where('companyId', '=', companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (inv.pdfDocumentId) return; // attached meanwhile by another delivery
      const { documentId } = await recordDocument(tx, {
        companyId,
        kind: 'SALES_INVOICE_PDF',
        filename: prepared.filename,
        mimeType: 'application/pdf',
        blob: prepared.blob,
        now,
      });
      await tx
        .updateTable('sales.invoices')
        .set({ pdfDocumentId: documentId })
        .where('id', '=', invoiceId)
        .execute();
      await writeAudit(
        tx,
        [
          {
            entityType: 'sales.invoice',
            entityId: invoiceId,
            after: { pdfDocumentId: documentId, sha256: prepared.blob.sha256 },
          },
        ],
        {
          actor: systemActor(`outbox:${event.id}`),
          command: 'documents.salesInvoicePdf.generate',
          companyId,
          occurredAt: now,
        },
      );
    },
  });
}

const CreditNotePayload = z.object({ creditNoteId: z.uuid(), companyId: z.uuid() });

/** Outbox handler for `sales.credit_note.issued` — same two phases and guarantees. */
export function creditNotePdfHandler(deps: PdfDeps): OutboxHandler {
  return defineOutboxHandler<RenderedPdf | null>({
    async prepare({ db, event }) {
      const { creditNoteId, companyId } = CreditNotePayload.parse(event.payload);
      const cn = await db
        .selectFrom('sales.creditNotes')
        .select(['status', 'creditNoteNumber', 'pdfDocumentId'])
        .where('id', '=', creditNoteId)
        .where('companyId', '=', companyId)
        .executeTakeFirst();
      if (!cn?.creditNoteNumber || cn.status !== 'ISSUED')
        throw new Error(`Credit note ${creditNoteId} is not issued`);
      if (cn.pdfDocumentId) return null;
      return renderToBlob(deps, await buildCreditNotePrintModel(db, creditNoteId));
    },
    async apply({ tx, event, now, prepared }) {
      if (!prepared) return;
      const { creditNoteId, companyId } = CreditNotePayload.parse(event.payload);
      const cn = await tx
        .selectFrom('sales.creditNotes')
        .select('pdfDocumentId')
        .where('id', '=', creditNoteId)
        .where('companyId', '=', companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (cn.pdfDocumentId) return;
      const { documentId } = await recordDocument(tx, {
        companyId,
        kind: 'SALES_CREDIT_NOTE_PDF',
        filename: prepared.filename,
        mimeType: 'application/pdf',
        blob: prepared.blob,
        now,
      });
      await tx
        .updateTable('sales.creditNotes')
        .set({ pdfDocumentId: documentId })
        .where('id', '=', creditNoteId)
        .execute();
      await writeAudit(
        tx,
        [
          {
            entityType: 'sales.credit_note',
            entityId: creditNoteId,
            after: { pdfDocumentId: documentId, sha256: prepared.blob.sha256 },
          },
        ],
        {
          actor: systemActor(`outbox:${event.id}`),
          command: 'documents.salesCreditNotePdf.generate',
          companyId,
          occurredAt: now,
        },
      );
    },
  });
}

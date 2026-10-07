import { z } from 'zod';
import type { DbTransaction } from '../../../db/database';
import { systemActor } from '../../../platform/actor';
import { writeAudit } from '../../../platform/audit';
import type { BlobStore } from '../../../platform/blob-store';
import { uuidv7 } from '../../../platform/ids';
import type { OutboxHandler } from '../../../platform/outbox';
import type { PdfRenderer } from '../../../platform/pdf';
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

/** Render → content-addressed blob → immutable docs.documents row. Returns the document id. */
async function storePdf(
  deps: PdfDeps,
  tx: DbTransaction,
  args: {
    companyId: string;
    kind: 'SALES_INVOICE_PDF' | 'SALES_CREDIT_NOTE_PDF';
    model: SalesPrintModel;
    now: Date;
  },
): Promise<{ documentId: string; sha256: string }> {
  const pdf = await deps.renderer.render(renderSalesDocumentHtml(args.model));
  const blob = await deps.blobStore.put(pdf);
  const documentId = uuidv7(args.now.getTime());
  await tx
    .insertInto('docs.documents')
    .values({
      id: documentId,
      companyId: args.companyId,
      kind: args.kind,
      filename: `${args.model.documentNumber.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: String(blob.sizeBytes),
      sha256: blob.sha256,
      storageKey: blob.storageKey,
      createdAt: args.now,
    })
    .execute();
  return { documentId, sha256: blob.sha256 };
}

const InvoicePayload = z.object({ invoiceId: z.uuid(), companyId: z.uuid() });

/**
 * Outbox handler for `sales.invoice.issued`: render, store and attach the invoice PDF.
 * Idempotent — an invoice that already has a PDF is left untouched, so retries are safe.
 * The PDF is generated once and never regenerated (the SQL guard enforces it).
 */
export function invoicePdfHandler(deps: PdfDeps): OutboxHandler {
  return async ({ tx, event, now }) => {
    const { invoiceId, companyId } = InvoicePayload.parse(event.payload);
    const inv = await tx
      .selectFrom('sales.invoices')
      .select(['id', 'status', 'invoiceNumber', 'pdfDocumentId'])
      .where('id', '=', invoiceId)
      .where('companyId', '=', companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!inv?.invoiceNumber || inv.status === 'DRAFT')
      throw new Error(`Invoice ${invoiceId} is not issued`);
    if (inv.pdfDocumentId) return;

    const model = await buildInvoicePrintModel(tx, invoiceId);
    const { documentId, sha256 } = await storePdf(deps, tx, {
      companyId,
      kind: 'SALES_INVOICE_PDF',
      model,
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
          after: { pdfDocumentId: documentId, sha256 },
        },
      ],
      {
        actor: systemActor(`outbox:${event.id}`),
        command: 'documents.salesInvoicePdf.generate',
        companyId,
        occurredAt: now,
      },
    );
  };
}

const CreditNotePayload = z.object({ creditNoteId: z.uuid(), companyId: z.uuid() });

/** Outbox handler for `sales.credit_note.issued` — same guarantees as the invoice handler. */
export function creditNotePdfHandler(deps: PdfDeps): OutboxHandler {
  return async ({ tx, event, now }) => {
    const { creditNoteId, companyId } = CreditNotePayload.parse(event.payload);
    const cn = await tx
      .selectFrom('sales.creditNotes')
      .select(['id', 'status', 'creditNoteNumber', 'pdfDocumentId'])
      .where('id', '=', creditNoteId)
      .where('companyId', '=', companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!cn?.creditNoteNumber || cn.status !== 'ISSUED')
      throw new Error(`Credit note ${creditNoteId} is not issued`);
    if (cn.pdfDocumentId) return;

    const model = await buildCreditNotePrintModel(tx, creditNoteId);
    const { documentId, sha256 } = await storePdf(deps, tx, {
      companyId,
      kind: 'SALES_CREDIT_NOTE_PDF',
      model,
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
          after: { pdfDocumentId: documentId, sha256 },
        },
      ],
      {
        actor: systemActor(`outbox:${event.id}`),
        command: 'documents.salesCreditNotePdf.generate',
        companyId,
        occurredAt: now,
      },
    );
  };
}

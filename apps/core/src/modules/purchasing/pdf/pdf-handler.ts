import { z } from 'zod';
import { systemActor } from '../../../platform/actor';
import { writeAudit } from '../../../platform/audit';
import type { BlobStore, StoredBlob } from '../../../platform/blob-store';
import { defineOutboxHandler, type OutboxHandler } from '../../../platform/outbox';
import type { PdfRenderer } from '../../../platform/pdf';
import { recordDocument } from '../../documents';
import { buildPurchaseOrderPrintModel } from './print-model';
import { renderPurchaseOrderHtml } from './template';

const Payload = z.object({ orderId: z.uuid(), companyId: z.uuid() });

interface RenderedPdf {
  blob: StoredBlob;
  filename: string;
}

/**
 * Outbox handler for `purchase.order.approved`: render, store and attach the PO PDF.
 *
 * The approved order is the record; its PDF is a side effect that can fail and be retried
 * without touching it. Rendering happens in `prepare` with no lock (an approved order's
 * content can no longer change); `apply` locks the order only to attach the document.
 * Idempotent: an order that already has a PDF is left alone (SQL refuses replacing one).
 */
export function purchaseOrderPdfHandler(deps: {
  blobStore: BlobStore;
  renderer: PdfRenderer;
}): OutboxHandler {
  return defineOutboxHandler<RenderedPdf | null>({
    async prepare({ db, event }) {
      const { orderId, companyId } = Payload.parse(event.payload);
      const o = await db
        .selectFrom('purchase.orders')
        .select(['poNumber', 'pdfDocumentId'])
        .where('id', '=', orderId)
        .where('companyId', '=', companyId)
        .executeTakeFirst();
      if (!o?.poNumber) throw new Error(`Purchase order ${orderId} is not approved`);
      if (o.pdfDocumentId) return null;
      const model = await buildPurchaseOrderPrintModel(db, orderId);
      const pdf = await deps.renderer.render(renderPurchaseOrderHtml(model));
      return {
        blob: await deps.blobStore.put(pdf),
        filename: `${model.poNumber.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`,
      };
    },
    async apply({ tx, event, now, prepared }) {
      if (!prepared) return;
      const { orderId, companyId } = Payload.parse(event.payload);
      const o = await tx
        .selectFrom('purchase.orders')
        .select('pdfDocumentId')
        .where('id', '=', orderId)
        .where('companyId', '=', companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (o.pdfDocumentId) return;
      const { documentId } = await recordDocument(tx, {
        companyId,
        kind: 'PURCHASE_ORDER_PDF',
        filename: prepared.filename,
        mimeType: 'application/pdf',
        blob: prepared.blob,
        now,
      });
      await tx
        .updateTable('purchase.orders')
        .set({ pdfDocumentId: documentId })
        .where('id', '=', orderId)
        .execute();
      await writeAudit(
        tx,
        [
          {
            entityType: 'purchase.order',
            entityId: orderId,
            after: { pdfDocumentId: documentId, sha256: prepared.blob.sha256 },
          },
        ],
        {
          actor: systemActor(`outbox:${event.id}`),
          command: 'documents.purchaseOrderPdf.generate',
          companyId,
          occurredAt: now,
        },
      );
    },
  });
}

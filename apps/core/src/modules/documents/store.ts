import type { DbTransaction } from '../../db/database';
import type { StoredBlob } from '../../platform/blob-store';
import { uuidv7 } from '../../platform/ids';

/** Kinds of stored document. Each kind's access rule lives in ./access.ts. */
export type DocumentKind = 'SALES_INVOICE_PDF' | 'SALES_CREDIT_NOTE_PDF' | 'PURCHASE_ORDER_PDF';

/**
 * Record an already-stored blob as an immutable document (docs.documents is append-only).
 * The documents module owns this table; other modules call this inside their transaction.
 */
export async function recordDocument(
  tx: DbTransaction,
  args: {
    companyId: string;
    kind: DocumentKind;
    filename: string;
    mimeType: string;
    blob: StoredBlob;
    now: Date;
  },
): Promise<{ documentId: string }> {
  const documentId = uuidv7(args.now.getTime());
  await tx
    .insertInto('docs.documents')
    .values({
      id: documentId,
      companyId: args.companyId,
      kind: args.kind,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: String(args.blob.sizeBytes),
      sha256: args.blob.sha256,
      storageKey: args.blob.storageKey,
      createdAt: args.now,
    })
    .execute();
  return { documentId };
}

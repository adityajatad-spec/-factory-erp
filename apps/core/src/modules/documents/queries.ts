import { PERMISSIONS, Uuid } from '@factory-erp/contracts';
import { z } from 'zod';
import type { BlobStore } from '../../platform/blob-store';
import { ForbiddenError, NotFoundError } from '../../platform/errors';
import { sha256Hex } from '../../platform/json';
import { defineQuery } from '../../platform/queries';
import { accessRuleFor } from './access';

export interface DocumentContent {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Download a stored document. Access comes from the record the document belongs to (see
 * ./access.ts): reading an invoice PDF needs permission to read invoices, and the invoice must
 * point at this document. Content is verified against its recorded SHA-256.
 */
export function getDocumentContentQuery(blobStore: BlobStore) {
  return defineQuery({
    name: 'documents.content.get',
    description: 'Download a stored document such as an issued invoice PDF.',
    input: z.object({ documentId: Uuid }),
    // Any member may ask; the owning record's permission decides (checked in the handler).
    permission: PERMISSIONS.companyRead,
    ai: { tier: 'FORBIDDEN' },
    dataClass: 'RESTRICTED', // the PDF shows the company bank account
    handler: async ({ db, companyId, can }, input): Promise<DocumentContent> => {
      const doc = await db
        .selectFrom('docs.documents')
        .select(['kind', 'filename', 'mimeType', 'sha256', 'storageKey'])
        .where('id', '=', input.documentId)
        .where('companyId', '=', companyId)
        .executeTakeFirst();
      if (!doc) throw new NotFoundError('Document');
      const rule = accessRuleFor(doc.kind);
      // Deny by default: a kind without a rule is readable by nobody.
      if (!rule) throw new ForbiddenError(`documents of kind ${doc.kind}`);
      if (!can(rule.permission)) throw new ForbiddenError(rule.permission);
      if (!(await rule.attached(db, companyId, input.documentId))) {
        throw new NotFoundError('Document');
      }
      const content = await blobStore.read(doc.storageKey);
      if (sha256Hex(content) !== doc.sha256)
        throw new Error(`Document ${input.documentId} failed its integrity check`);
      return { filename: doc.filename, mimeType: doc.mimeType, content };
    },
  });
}

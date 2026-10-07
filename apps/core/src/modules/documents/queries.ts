import { PERMISSIONS, Uuid } from '@factory-erp/contracts';
import { z } from 'zod';
import type { BlobStore } from '../../platform/blob-store';
import { NotFoundError } from '../../platform/errors';
import { sha256Hex } from '../../platform/json';
import { defineQuery } from '../../platform/queries';

export interface DocumentContent {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Download a stored document. Content is verified against its recorded SHA-256. */
export function getDocumentContentQuery(blobStore: BlobStore) {
  return defineQuery({
    name: 'documents.content.get',
    description: 'Download a stored document such as an issued invoice PDF.',
    input: z.object({ documentId: Uuid }),
    permission: PERMISSIONS.documentRead,
    ai: { tier: 'FORBIDDEN' },
    handler: async ({ db, companyId }, input): Promise<DocumentContent> => {
      const doc = await db
        .selectFrom('docs.documents')
        .select(['filename', 'mimeType', 'sha256', 'storageKey'])
        .where('id', '=', input.documentId)
        .where('companyId', '=', companyId)
        .executeTakeFirst();
      if (!doc) throw new NotFoundError('Document');
      const content = await blobStore.read(doc.storageKey);
      if (sha256Hex(content) !== doc.sha256)
        throw new Error(`Document ${input.documentId} failed its integrity check`);
      return { filename: doc.filename, mimeType: doc.mimeType, content };
    },
  });
}

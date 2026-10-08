import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { salesFlows } from '../../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { AuthenticatedActor } from '../../platform/actor';
import { ForbiddenError, NotFoundError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import type { PdfRenderer } from '../../platform/pdf';
import { DOCUMENT_ACCESS, getDocumentContentQuery, UNREADABLE_KINDS } from './index';

const TODAY = '2026-10-05';
const renderer: PdfRenderer = {
  render: (html) => Promise.resolve(Buffer.from(`%PDF-1.4 access ${html.length}`)),
  close: () => Promise.resolve(),
};
let env: TestEnv;
let fx: Fixture;
let invoicePdf: string;
let creditNotePdf: string;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);
const download = (documentId: string, actor: AuthenticatedActor) =>
  env.services.queries.execute(
    getDocumentContentQuery(env.services.blobStore),
    { documentId },
    actor,
  );

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z`, pdfRenderer: renderer });
  fx = await createFixture(env.services);
  const inv = await f.issued('500');
  const cn = await f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '10' }]);
  await env.services.outbox.runOnce(10);
  invoicePdf = (await f.invoice(inv.id)).pdfDocumentId ?? '';
  creditNotePdf = (await f.creditNote(cn.id)).pdfDocumentId ?? '';
  expect(invoicePdf && creditNotePdf).toBeTruthy();
});
afterAll(async () => env.destroy());

/** Insert a document row directly (as the owner) — something no command can produce. */
async function rawDocument(kind: string): Promise<string> {
  const blob = await env.services.blobStore.put(Buffer.from(`%PDF-1.4 ${kind}`));
  const id = uuidv7();
  await env.ownerDb
    .insertInto('docs.documents')
    .values({
      id,
      companyId: fx.companyId,
      kind,
      filename: 'x.pdf',
      mimeType: 'application/pdf',
      sizeBytes: String(blob.sizeBytes),
      sha256: blob.sha256,
      storageKey: blob.storageKey,
    })
    .execute();
  return id;
}

describe('document access follows the owning record', () => {
  it('every document kind the database allows has a rule or a stated reason to be unreadable', async () => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'documents_kind_check'`.execute(
      env.ownerDb,
    );
    const kinds = [...(rows[0]?.def ?? '').matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds) {
      expect(kind && (kind in DOCUMENT_ACCESS || kind in UNREADABLE_KINDS), `kind ${kind}`).toBe(
        true,
      );
    }
  });

  it('whoever may read invoices may read invoice and credit-note PDFs', async () => {
    for (const id of [invoicePdf, creditNotePdf]) {
      const doc = await download(id, fx.actors.accountant);
      expect(doc.content.subarray(0, 8).toString()).toBe('%PDF-1.4');
    }
  });

  it('nobody else may — the permission comes from the invoice, not from "documents"', async () => {
    for (const id of [invoicePdf, creditNotePdf]) {
      const err = await download(id, fx.actors.worker).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as Error).message).toContain('sales.invoice.read');
    }
  });

  it('a kind without a rule is denied to everyone, even the owner (deny by default)', async () => {
    const upload = await rawDocument('UPLOAD');
    await expect(download(upload, fx.actors.owner)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a document no record points at is not served, even to the owner', async () => {
    const orphan = await rawDocument('SALES_INVOICE_PDF');
    await expect(download(orphan, fx.actors.owner)).rejects.toBeInstanceOf(NotFoundError);
  });
});

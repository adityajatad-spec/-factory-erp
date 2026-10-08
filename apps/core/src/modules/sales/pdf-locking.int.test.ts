import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { salesFlows } from '../../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { PdfRenderer } from '../../platform/pdf';
import { invoicePdfHandler } from './index';

/**
 * Rendering a PDF must never hold up money (Slice 0, task 9). A renderer that blocks until we
 * release it keeps a PDF "mid-render"; meanwhile payments, credit notes and cancellation on the
 * very same invoice must complete promptly, and the books must be right afterwards.
 */
const TODAY = '2026-10-05';
const PROMPT_MS = 2_000;

/** Finish every queued job (renderer open), so the next job under test is the only one. */
async function drain() {
  current.open();
  await env.services.outbox.runOnce(50);
}

function gate() {
  let open!: () => void;
  let started!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const began = new Promise<void>((r) => (started = r));
  return { opened, began, open, started };
}
let current = gate();
const blockingRenderer: PdfRenderer = {
  render: async (html) => {
    current.started();
    await current.opened;
    return Buffer.from(`%PDF-1.4 locking ${html.length}`);
  },
  close: () => Promise.resolve(),
};

/** Resolve with `p`, or fail if it is still waiting (e.g. on a row lock) after `ms`. */
function promptly<T>(p: Promise<T>, what: string, ms = PROMPT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} was blocked for ${ms} ms by the PDF render`)), ms),
    ),
  ]);
}

let env: TestEnv;
let fx: Fixture;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z`, pdfRenderer: blockingRenderer });
  fx = await createFixture(env.services);
});
afterAll(async () => {
  current.open();
  await env.destroy();
});

describe('PDF rendering happens outside the financial lock', () => {
  it('a payment and a credit note on the invoice complete while its PDF renders', async () => {
    await drain();
    current = gate();
    const inv = await f.issued('8474.58'); // ₹10,000.00
    const job = env.services.outbox.runOnce(1);
    await current.began;
    try {
      await promptly(f.receipt('4000.00', [{ invoiceId: inv.id, amount: '4000.00' }]), 'a payment');
      await promptly(
        f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '1694.92' }]),
        'a credit note',
      );
    } finally {
      current.open();
      await job;
    }
    const after = await f.invoice(inv.id);
    expect(after.pdfDocumentId).not.toBeNull();
    expect(after).toMatchObject({
      paidAmount: '4000.00',
      creditedAmount: '2000.00',
      outstandingAmount: '4000.00',
    });
  });

  it('a cancellation completes while the PDF renders; the issued PDF is still attached', async () => {
    await drain();
    current = gate();
    const inv = await f.issued('500');
    const job = env.services.outbox.runOnce(1);
    await current.began;
    try {
      await promptly(f.cancel(inv), 'a cancellation');
    } finally {
      current.open();
      await job;
    }
    const after = await f.invoice(inv.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.pdfDocumentId).not.toBeNull();
  });

  it('a duplicate delivery attaches exactly one document', async () => {
    current = gate();
    current.open();
    const inv = await f.issued('100');
    const event = await env.services.db
      .selectFrom('system.outboxEvents')
      .selectAll()
      .where('aggregateId', '=', inv.id)
      .executeTakeFirstOrThrow();
    const handler = invoicePdfHandler({
      blobStore: env.services.blobStore,
      renderer: blockingRenderer,
    });
    const now = new Date();
    // Two deliveries render concurrently, then both try to attach.
    const [p1, p2] = await Promise.all([
      handler.prepare?.({ db: env.services.db, event, now }),
      handler.prepare?.({ db: env.services.db, event, now }),
    ]);
    for (const prepared of [p1, p2]) {
      await env.services.db
        .transaction()
        .execute((tx) => handler.apply({ tx, event, now, prepared }));
    }
    const docs = await env.ownerDb
      .selectFrom('docs.documents as d')
      .innerJoin('sales.invoices as i', 'i.pdfDocumentId', 'd.id')
      .select('d.id')
      .where('i.id', '=', inv.id)
      .execute();
    expect(docs).toHaveLength(1);
    const generated = await env.ownerDb
      .selectFrom('audit.events')
      .select('id')
      .where('entityId', '=', inv.id)
      .where('command', '=', 'documents.salesInvoicePdf.generate')
      .execute();
    expect(generated).toHaveLength(1);
  });
});

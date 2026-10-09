import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { purchaseFlows } from '../../../test/purchase-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { PdfRenderer } from '../../platform/pdf';
import { getDocumentContentQuery } from '../documents';

const TODAY = '2026-10-05';
const rendered: string[] = [];
let failNext = false;
const renderer: PdfRenderer = {
  render: (html) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('renderer unavailable'));
    }
    rendered.push(html);
    return Promise.resolve(Buffer.from(`%PDF-1.4 po ${html.length}`));
  },
  close: () => Promise.resolve(),
};
let env: TestEnv;
let fx: Fixture;
const p = purchaseFlows(
  () => env,
  () => fx,
  TODAY,
);

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z`, pdfRenderer: renderer });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

describe('purchase order PDF (outbox side effect)', () => {
  it('is rendered after approval, attached once, and readable only with purchase-order access', async () => {
    const po = await p.approvedPo([p.steel('100', '50')]);
    expect(po.pdfDocumentId).toBeNull(); // approval never waits for the renderer
    await env.services.outbox.runOnce(10);
    const after = await p.order(po.id);
    expect(after.pdfDocumentId).not.toBeNull();
    const html = rendered.at(-1) ?? '';
    expect(html).toContain('PURCHASE ORDER');
    expect(html).toContain(po.poNumber ?? '?');
    expect(html).toContain(fx.suppliers.local.name);
    expect(html).toContain('SPECIMEN');

    const download = env.services.queries;
    const doc = await download.execute(
      getDocumentContentQuery(env.services.blobStore),
      { documentId: after.pdfDocumentId ?? '' },
      fx.actors.purchase,
    );
    expect(doc.mimeType).toBe('application/pdf');
    await expect(
      download.execute(
        getDocumentContentQuery(env.services.blobStore),
        { documentId: after.pdfDocumentId ?? '' },
        fx.actors.worker,
      ),
    ).rejects.toThrow();

    // A second delivery of the same event changes nothing.
    await env.services.outbox.runOnce(10);
    expect((await p.order(po.id)).pdfDocumentId).toBe(after.pdfDocumentId);
  });

  it('a failing renderer leaves the approved order intact; a retry attaches the PDF', async () => {
    failNext = true;
    const po = await p.approvedPo();
    await env.services.outbox.runOnce(10);
    const failed = await p.order(po.id);
    expect(failed).toMatchObject({ status: 'APPROVED', pdfDocumentId: null });
    await env.ownerDb
      .updateTable('system.outboxEvents')
      .set({ availableAt: new Date(0) })
      .where('aggregateId', '=', po.id)
      .execute();
    await env.services.outbox.runOnce(10);
    expect((await p.order(po.id)).pdfDocumentId).not.toBeNull();
  });
});

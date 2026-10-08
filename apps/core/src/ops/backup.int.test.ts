import { cp, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { runtimeUrl } from '../../test/global-setup';
import { salesFlows } from '../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { createLogger } from '../logger';
import { getDocumentContentQuery } from '../modules/documents/queries';
import { getReceivablesSummary } from '../modules/receivables/summary';
import { getInvoice } from '../modules/sales/queries';
import type { PdfRenderer } from '../platform/pdf';
import { createServices } from '../services';
import {
  BackupError,
  createBackup,
  restoreBackup,
  verifyBackup,
  verifyBackupFiles,
} from './backup';

const TODAY = '2026-10-05';
const renderer: PdfRenderer = {
  render: (html) => Promise.resolve(Buffer.from(`%PDF-1.4 backup test ${html.length}`)),
  close: () => Promise.resolve(),
};

let env: TestEnv;
let fx: Fixture;
let work: string;
let backupDir: string;
const restoredDbs: string[] = [];
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z`, pdfRenderer: renderer });
  fx = await createFixture(env.services);
  work = await mkdtemp(path.join(tmpdir(), 'ferp-backup-'));

  // A small but complete set of books: PDFs, a part payment, a credit note and a cancellation.
  const paid = await f.issued('8474.58');
  await f.receipt('6000.00', [{ invoiceId: paid.id, amount: '6000.00' }]);
  await f.credit(await f.issued('1694.92'), [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }]);
  await f.cancel(await f.issued('500'));
  await f.receipt('750.00');
  await env.services.outbox.runOnce(50);
});

afterAll(async () => {
  const admin = new pg.Client({ connectionString: env.ownerUrl });
  await admin.connect();
  for (const db of restoredDbs) await admin.query(`drop database if exists "${db}" with (force)`);
  await admin.end();
  await env.destroy();
  await rm(work, { recursive: true, force: true });
});

describe('backup → verify → restore', () => {
  it('backs up the database and every blob, with counts from the same snapshot', async () => {
    const { dir, manifest } = await createBackup({
      ownerUrl: env.ownerUrl,
      dataDir: env.dataDir,
      backupRoot: path.join(work, 'backups'),
    });
    backupDir = dir;
    expect(path.basename(dir)).toMatch(/^factoryerp-\d{8}T\d{6}Z$/);
    expect(manifest.schemaVersion).toMatch(/^\d{4}$/);
    expect(manifest.counts).toMatchObject({
      'sales.invoices': 3,
      'sales.credit_notes': 1,
      'finance.receipts': 2,
      'docs.documents': 4, // three invoice PDFs and one credit-note PDF
    });
    expect(manifest.blobs.count).toBe(4);
  });

  it('passes the restore drill: files intact, restored counts equal, documents present, books reconcile', async () => {
    const { problems } = await verifyBackup({ dir: backupDir, ownerUrl: env.ownerUrl });
    expect(problems).toEqual([]);
  });

  it('detects a corrupted blob, a damaged dump and an incomplete backup', async () => {
    const copy = async (name: string) => {
      const to = path.join(work, name);
      await cp(backupDir, to, { recursive: true });
      return to;
    };
    const badBlob = await copy('bad-blob');
    const { readdir } = await import('node:fs/promises');
    const blobs = (
      await readdir(path.join(badBlob, 'blobs'), { recursive: true, withFileTypes: true })
    )
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name));
    await writeFile(blobs[0] ?? '', 'tampered');
    expect((await verifyBackupFiles(badBlob)).problems.join()).toMatch(/is corrupt/);

    const badDump = await copy('bad-dump');
    await truncate(path.join(badDump, 'database.dump'), 100);
    expect((await verifyBackup({ dir: badDump, ownerUrl: env.ownerUrl })).problems.join()).toMatch(
      /does not match its recorded checksum/,
    );

    const incomplete = await copy('incomplete');
    await rm(path.join(incomplete, 'manifest.json'));
    await expect(verifyBackupFiles(incomplete)).rejects.toBeInstanceOf(BackupError);
  });

  it('restores into a new database that the runtime role can use like the original', async () => {
    const database = `ferp_restored_${process.pid}`;
    restoredDbs.push(database);
    const dataDir = path.join(work, 'restored-data');
    const { blobsCopied } = await restoreBackup({
      dir: backupDir,
      ownerUrl: env.ownerUrl,
      database,
      dataDir,
    });
    expect(blobsCopied).toBe(4);

    const restored = createServices(
      { ...env.services.config, databaseUrl: runtimeUrl(env.ownerUrl, database), dataDir },
      createLogger('silent'),
      { pdfRenderer: renderer, clock: env.services.clock },
    );
    try {
      const actor = fx.actors.accountant;
      const before = await env.services.queries.execute(getReceivablesSummary, {}, actor);
      const after = await restored.queries.execute(getReceivablesSummary, {}, actor);
      expect(after).toEqual(before);

      const invoices = await env.services.db
        .selectFrom('sales.invoices')
        .select(['id', 'pdfDocumentId'])
        .where('pdfDocumentId', 'is not', null)
        .execute();
      for (const inv of invoices) {
        const restoredInvoice = await restored.queries.execute(
          getInvoice,
          { invoiceId: inv.id },
          actor,
        );
        expect(restoredInvoice.pdfDocumentId).toBe(inv.pdfDocumentId);
        // The download path re-verifies the blob against its recorded SHA-256.
        const doc = await restored.queries.execute(
          getDocumentContentQuery(restored.blobStore),
          { documentId: inv.pdfDocumentId },
          actor,
        );
        expect(doc.content.subarray(0, 8).toString()).toBe('%PDF-1.4');
      }
    } finally {
      await restored.close();
    }
  });

  it('never restores over an existing database', async () => {
    await expect(
      restoreBackup({
        dir: backupDir,
        ownerUrl: env.ownerUrl,
        database: new URL(env.ownerUrl).pathname.slice(1),
        dataDir: path.join(work, 'unused'),
      }),
    ).rejects.toThrow(/already exists/);
  });
});

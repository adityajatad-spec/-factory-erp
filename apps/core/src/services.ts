import type { Config } from './config';
import { createDatabase, type Database } from './db/database';
import type { Logger } from './logger';
import { AuthService } from './modules/identity/auth-service';
import { CREDIT_NOTE_ISSUED_TOPIC } from './modules/sales/credit-notes/commands';
import { INVOICE_ISSUED_TOPIC } from './modules/sales/issue-command';
import { creditNotePdfHandler, invoicePdfHandler } from './modules/sales/pdf/pdf-handler';
import { FileBlobStore, type BlobStore } from './platform/blob-store';
import { systemClock, type Clock } from './platform/clock';
import { CommandBus } from './platform/commands';
import { OutboxDispatcher } from './platform/outbox';
import { ChromiumPdfRenderer, type PdfRenderer } from './platform/pdf';
import { QueryBus } from './platform/queries';
import path from 'node:path';

/** Composition root: every long-lived service, wired once. Used by main.ts and tests. */
export interface Services {
  config: Config;
  logger: Logger;
  clock: Clock;
  db: Database;
  commands: CommandBus;
  queries: QueryBus;
  auth: AuthService;
  blobStore: BlobStore;
  pdfRenderer: PdfRenderer;
  outbox: OutboxDispatcher;
  close(): Promise<void>;
}

export function createServices(
  config: Config,
  logger: Logger,
  overrides: { clock?: Clock; db?: Database; pdfRenderer?: PdfRenderer } = {},
): Services {
  const clock = overrides.clock ?? systemClock;
  const db = overrides.db ?? createDatabase(config.databaseUrl);
  const blobStore = new FileBlobStore(path.join(config.dataDir, 'blobs'));
  const pdfRenderer = overrides.pdfRenderer ?? new ChromiumPdfRenderer(config.pdfBrowserExecutable);
  const outbox = new OutboxDispatcher({
    db,
    clock,
    logger,
    pollMs: config.outboxPollMs,
    handlers: {
      [INVOICE_ISSUED_TOPIC]: invoicePdfHandler({ blobStore, renderer: pdfRenderer }),
      [CREDIT_NOTE_ISSUED_TOPIC]: creditNotePdfHandler({ blobStore, renderer: pdfRenderer }),
    },
  });

  return {
    config,
    logger,
    clock,
    db,
    commands: new CommandBus({ db, clock, logger }),
    queries: new QueryBus({ db, clock }),
    auth: new AuthService({ db, clock, sessionTtlHours: config.sessionTtlHours }),
    blobStore,
    pdfRenderer,
    outbox,
    async close() {
      await outbox.stop();
      await pdfRenderer.close();
      await db.destroy();
    },
  };
}

import { createCopilot, type Copilot, type CopilotLimits } from './ai/copilot';
import { createAiService, type AiService, type AiServiceOptions } from './ai/service';
import { buildToolCatalog } from './ai/tools';
import type { Config } from './config';
import { createDatabase, type Database } from './db/database';
import type { Logger } from './logger';
import { AuthService, reloadSessionUser } from './modules/identity';
import { PURCHASE_ORDER_APPROVED_TOPIC, purchaseOrderPdfHandler } from './modules/purchasing';
import {
  CREDIT_NOTE_ISSUED_TOPIC,
  creditNotePdfHandler,
  INVOICE_ISSUED_TOPIC,
  invoicePdfHandler,
} from './modules/sales';
import { FileBlobStore, type BlobStore } from './platform/blob-store';
import { systemClock, type Clock } from './platform/clock';
import { CommandBus } from './platform/commands';
import { OutboxDispatcher } from './platform/outbox';
import { ChromiumPdfRenderer, type PdfRenderer } from './platform/pdf';
import { QueryBus } from './platform/queries';
import { createRateLimiter, type RateLimiter } from './platform/rate-limiter';
import { buildRegistry } from './registry';
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
  /** Optional local AI: never required for the ERP to start or to work. */
  ai: AiService;
  /** The only production caller of the model gateway (see ai/copilot.ts). */
  copilot: Copilot;
  /** Copilot turns per person per window, in this process only (not a distributed limit). */
  copilotRateLimiter: RateLimiter;
  close(): Promise<void>;
}

export function createServices(
  config: Config,
  logger: Logger,
  overrides: {
    clock?: Clock;
    db?: Database;
    pdfRenderer?: PdfRenderer;
    ai?: AiServiceOptions;
    /** Tests only: tighter turn limits (production uses the defaults). */
    copilotLimits?: Partial<CopilotLimits>;
    /** Tests only: a limiter with a test clock (production builds it from the config). */
    copilotRateLimiter?: RateLimiter;
  } = {},
): Services {
  const clock = overrides.clock ?? systemClock;
  const db =
    overrides.db ??
    createDatabase(config.databaseUrl, { acquireTimeoutMs: config.databasePoolAcquireTimeoutMs });
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
      [PURCHASE_ORDER_APPROVED_TOPIC]: purchaseOrderPdfHandler({
        blobStore,
        renderer: pdfRenderer,
      }),
    },
  });

  // No network call here: AI availability is checked only on demand, within a bound.
  const ai = createAiService(config.ai, overrides.ai);
  const queries = new QueryBus({ db, clock });
  // The tool catalogue is checked against the registry here: a drifted tool stops startup.
  const copilot = createCopilot({
    ai,
    queries,
    catalog: buildToolCatalog(buildRegistry({ blobStore })),
    currentUser: (user) => reloadSessionUser(db, user, clock.now()),
    limits: { turnTimeoutMs: 2 * config.ai.timeoutMs, ...overrides.copilotLimits },
    logger,
  });

  const copilotRateLimiter =
    overrides.copilotRateLimiter ??
    createRateLimiter({
      limit: config.copilotRateLimit.turns,
      windowMs: config.copilotRateLimit.windowMs,
    });

  return {
    config,
    logger,
    ai,
    copilot,
    copilotRateLimiter,
    clock,
    db,
    commands: new CommandBus({ db, clock, logger }),
    queries,
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

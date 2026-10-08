import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import type { Config } from '../src/config';
import { createDatabase, type Database } from '../src/db/database';
import { createLogger } from '../src/logger';
import { fixedClock, systemClock, type Clock } from '../src/platform/clock';
import type { PdfRenderer } from '../src/platform/pdf';
import { createServices, type Services } from '../src/services';
import { runtimeUrl, withDatabase } from './global-setup';

const LOCK_KEY = 4_242_001;

export interface TestEnv {
  /** Wired like the real server: connected as the least-privilege runtime role. */
  services: Services;
  /** Runtime-role URL of this test database. */
  databaseUrl: string;
  /** Owner-role URL of this test database (migrations, backups, privilege tests). */
  ownerUrl: string;
  /** Owner-role connection, for tests that must prove a guard binds even the schema owner. */
  ownerDb: Database;
  /** Blob store root for this environment. */
  dataDir: string;
  destroy(): Promise<void>;
}

/** A fresh database cloned from the migrated template, plus wired services. */
export async function createTestEnv(
  opts: { clock?: Clock | string; pdfRenderer?: PdfRenderer } = {},
): Promise<TestEnv> {
  const adminUrl = inject('testDbAdminUrl');
  const template = inject('testTemplateDb');
  const name = `ferp_test_${process.pid}_${randomBytes(4).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Serialise clones: PostgreSQL refuses concurrent use of a template database.
    await admin.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await admin.query(`create database ${name} template ${template}`);
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await admin.end();
  }

  const ownerUrl = withDatabase(adminUrl, name);
  const databaseUrl = runtimeUrl(adminUrl, name);
  const ownerDb = createDatabase(ownerUrl, { maxConnections: 2 });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ferp-test-'));
  const config: Config = {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseUrl,
    databaseOwnerUrl: undefined,
    dataDir,
    cookieSecure: false,
    sessionTtlHours: 12,
    pdfBrowserExecutable: undefined,
    webDistDir: undefined,
    outboxPollMs: 1000,
    loginRateLimitPerMinute: 10,
  };
  const clock =
    typeof opts.clock === 'string' ? fixedClock(opts.clock) : (opts.clock ?? systemClock);
  const services = createServices(config, createLogger('silent'), {
    clock,
    ...(opts.pdfRenderer ? { pdfRenderer: opts.pdfRenderer } : {}),
  });

  return {
    services,
    databaseUrl,
    ownerUrl,
    ownerDb,
    dataDir,
    async destroy() {
      await services.close();
      await ownerDb.destroy();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

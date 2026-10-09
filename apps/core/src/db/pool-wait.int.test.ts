import type { ProblemDetails } from '@factory-erp/contracts';
import { sql } from 'kysely';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { buildApp } from '../http/app';
import { createSession } from '../modules/identity/sessions';
import { DatabaseUnavailableError } from '../platform/errors';
import { createDatabase, type Database } from './database';

/**
 * The pool's bounded acquisition wait (pg-pool connectionTimeoutMillis): a caller waits at most
 * `acquireTimeoutMs` for a connection, then gets DatabaseUnavailableError (503). A connection
 * already held — a transaction, a long statement — is not affected by it.
 */
const WAIT_MS = 300;
let env: TestEnv;
let fx: Fixture;
let db: Database;

beforeAll(async () => {
  env = await createTestEnv({ database: { maxConnections: 1, acquireTimeoutMs: WAIT_MS } });
  fx = await createFixture(env.services);
  db = env.services.db;
});
afterAll(async () => env.destroy());

/** Hold the pool's only connection inside a transaction until `release()`. */
function holdTheOnlyConnection() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  let started: () => void = () => undefined;
  const ready = new Promise<void>((r) => (started = r));
  const tx = db.transaction().execute(async (t) => {
    await sql`select 1`.execute(t);
    started();
    await released;
    const r = await sql<{ ok: number }>`select 1 as ok`.execute(t);
    return r.rows[0]?.ok;
  });
  return { ready, release: () => release(), tx };
}
const one = async (d: Database) => (await sql<{ v: number }>`select 1 as v`.execute(d)).rows[0]?.v;

describe('waiting for a pooled connection', () => {
  it('is bounded: with every connection busy, a caller fails with 503 DATABASE_UNAVAILABLE in time', async () => {
    const held = holdTheOnlyConnection();
    await held.ready;
    const t0 = performance.now();
    const err: unknown = await one(db).catch((e: unknown) => e);
    const waited = performance.now() - t0;
    expect(err).toBeInstanceOf(DatabaseUnavailableError);
    expect(err).toMatchObject({ code: 'DATABASE_UNAVAILABLE', httpStatus: 503 });
    // pg-pool's own message, pinned: the mapping depends on it.
    expect((err as Error).cause).toMatchObject({
      message: 'timeout exceeded when trying to connect',
    });
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 20);
    expect(waited).toBeLessThan(WAIT_MS + 1_500);

    // The held transaction was not disturbed, and the pool recovers.
    held.release();
    expect(await held.tx).toBe(1);
    expect(await one(db)).toBe(1);
  });

  it('bounds acquisition only: a transaction or a statement may hold a connection for longer', async () => {
    const held = holdTheOnlyConnection();
    await held.ready;
    await new Promise((r) => setTimeout(r, 2 * WAIT_MS));
    held.release();
    expect(await held.tx).toBe(1);

    const slow = await sql<{
      v: number;
    }>`select 1 as v from pg_sleep(${(2 * WAIT_MS) / 1000})`.execute(db);
    expect(slow.rows[0]?.v).toBe(1);
  });

  it('a waiter that gets a connection in time is served normally', async () => {
    const held = holdTheOnlyConnection();
    await held.ready;
    const waiting = one(db);
    setTimeout(() => held.release(), WAIT_MS / 3);
    expect(await waiting).toBe(1);
    expect(await held.tx).toBe(1);
  });

  it('opening a new connection is bounded too: a server that never answers gives 503', async () => {
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => accepted.push(socket)); // accepts, never speaks
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    const dead = createDatabase(`postgres://nobody:none@127.0.0.1:${port}/none`, {
      acquireTimeoutMs: WAIT_MS,
    });
    try {
      const t0 = performance.now();
      const err: unknown = await one(dead).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatabaseUnavailableError);
      expect((err as Error).cause).toMatchObject({
        message: 'Connection terminated due to connection timeout',
      });
      expect(performance.now() - t0).toBeLessThan(WAIT_MS + 1_500);
    } finally {
      await dead.destroy().catch(() => undefined);
      for (const socket of accepted) socket.destroy();
      await new Promise((r) => silent.close(r));
    }
  });

  it('over HTTP: a request that cannot get a connection is 503 problem+json with fixed text', async () => {
    const app = await buildApp(env.services);
    try {
      const { token } = await createSession(db, {
        userId: fx.actors.owner.user.id,
        companyId: fx.companyId,
        ttlHours: 1,
        now: new Date(),
        ip: null,
        userAgent: 'pool wait test',
      });
      const held = holdTheOnlyConnection();
      await held.ready;
      const res = await app.inject({
        url: '/api/v1/auth/me',
        headers: { cookie: `ferp_session=${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<ProblemDetails>()).toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        title: 'The system is busy right now. Please try again in a moment.',
      });
      expect(res.body).not.toMatch(/timeout exceeded|connect|pg-pool/i);
      const health = await app.inject('/api/v1/health/db');
      expect([health.statusCode, health.json()]).toEqual([503, { status: 'unavailable' }]);
      held.release();
      await held.tx;
      const ok = await app.inject({
        url: '/api/v1/auth/me',
        headers: { cookie: `ferp_session=${token}` },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

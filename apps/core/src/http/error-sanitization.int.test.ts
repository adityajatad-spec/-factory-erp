import { PERMISSIONS, type ProblemDetails } from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { loggerOptions } from '../logger';
import { listOutboxEvents } from '../modules/operations';
import { fixedClock } from '../platform/clock';
import { defineCommand } from '../platform/commands';
import { enqueueOutbox, OutboxDispatcher } from '../platform/outbox';
import { buildApp } from './app';

/**
 * Nothing internal reaches a client: database constraint names and row values, SQL text,
 * exception messages and stacks, or the requested path. Logs keep the SQLSTATE and table for
 * operators, but never PostgreSQL's message, detail (row values), SQL or constraint names —
 * also when the database error is wrapped as another error's cause. Every value below carries
 * a sentinel to search for.
 */
const SENTINEL = 'LEAKSENTINEL7';
const SECRET_TABLE = 'leak_sentinel_table';
/** PostgreSQL's names for the warehouse constraints these tests violate. */
const CONSTRAINT_NAMES = ['warehouses_company_id_code_key', 'warehouses_code_check'];
/** PostgreSQL error fields that must never be logged. */
const FORBIDDEN_PG_FIELDS = [
  'message',
  'detail',
  'where',
  'hint',
  'internalQuery',
  'stack',
  'constraint',
];

const logLines: string[] = [];
const logger = pino(loggerOptions('info', false), { write: (line: string) => logLines.push(line) });

let env: TestEnv;
let fx: Fixture;
let app: FastifyInstance;

/** A command that inserts the same warehouse twice: a unique violation inside the command bus. */
const duplicate = defineCommand({
  name: 'test.duplicate',
  description: 'test',
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, companyId }) => {
    for (let i = 0; i < 2; i++) {
      await tx
        .insertInto('inventory.warehouses')
        .values({ id: crypto.randomUUID(), companyId, code: SENTINEL, name: 'Sentinel store' })
        .execute();
    }
    return { result: null, audit: [{ entityType: 'test', entityId: companyId }] };
  },
});
/** A CHECK violation (lower-case code) whose PostgreSQL detail is the whole failing row. */
const checkViolation = defineCommand({
  name: 'test.check',
  description: 'test',
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, companyId }) => {
    await tx
      .insertInto('inventory.warehouses')
      .values({
        id: crypto.randomUUID(),
        companyId,
        code: SENTINEL.toLowerCase(),
        name: `${SENTINEL} row value`,
      })
      .execute();
    return { result: null, audit: [{ entityType: 'test', entityId: companyId }] };
  },
});

beforeAll(async () => {
  env = await createTestEnv({ logger });
  fx = await createFixture(env.services);
  app = await buildApp(env.services);
  // Test-only routes, behind the same error handler as every API route.
  app.post('/test/duplicate', () => env.services.commands.execute(duplicate, {}, fx.actors.owner));
  app.post('/test/check', () => env.services.commands.execute(checkViolation, {}, fx.actors.owner));
  app.get('/test/missing-table', async () => {
    await sql`select * from ${sql.raw(SECRET_TABLE)}`.execute(env.services.db);
    return {};
  });
  app.get('/test/bad-cast', async () => {
    await sql`select ${SENTINEL}::uuid`.execute(env.services.db);
    return {};
  });
  app.get('/test/raw-not-null', async () => {
    // Outside the command bus: no translation at all, so the raw PostgreSQL error reaches the handler.
    await sql`insert into inventory.warehouses (id, company_id, code, name)
              values (${crypto.randomUUID()}, ${fx.companyId}, ${SENTINEL}, null)`.execute(
      env.services.db,
    );
    return {};
  });
  app.get('/test/wrapped', async () => {
    // A CHECK violation (its detail is the failing row) wrapped by code that adds context.
    try {
      await sql`insert into inventory.warehouses (id, company_id, code, name)
                values (${crypto.randomUUID()}, ${fx.companyId}, ${SENTINEL.toLowerCase()}, ${SENTINEL})`.execute(
        env.services.db,
      );
    } catch (cause) {
      throw new Error('loading the report failed', { cause });
    }
    return {};
  });
  app.get('/test/exception', () => {
    throw new Error(`internal state ${SENTINEL} at /Users/somebody/secret/path.ts`);
  });
});
afterAll(async () => {
  await app.close();
  await env.destroy();
});

const leaks = (text: string) =>
  [
    SENTINEL,
    SENTINEL.toLowerCase(),
    SECRET_TABLE,
    'warehouses',
    'constraint',
    'Failing row',
  ].filter((s) => text.includes(s));

describe('database constraint failures', () => {
  it('a unique violation is 409 DUPLICATE with a generic message: no constraint name or value', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/duplicate' });
    expect(res.statusCode).toBe(409);
    expect(res.json<ProblemDetails>()).toEqual({
      type: 'about:blank',
      title: 'A record with the same unique value already exists',
      status: 409,
      code: 'DUPLICATE',
      requestId: expect.any(String) as string,
    });
    expect(leaks(res.body)).toEqual([]);
  });

  it('a CHECK violation is 422 with a stable rule code: no constraint name or row', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/check' });
    expect(res.statusCode).toBe(422);
    expect(res.json<ProblemDetails>()).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      detail: 'CONSTRAINT_VIOLATION',
      title: 'The data breaks a rule of the system',
    });
    expect(leaks(res.body)).toEqual([]);
  });

  it('operators see the SQLSTATE and table in the log; never row values or constraint names', () => {
    const rejected = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'command rejected by a database rule');
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'test.duplicate', sqlState: '23505' }),
        expect.objectContaining({ command: 'test.check', sqlState: '23514' }),
      ]),
    );
    expect(rejected.every((l) => l.table === 'warehouses' && !('constraint' in l))).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(SENTINEL);
    for (const name of CONSTRAINT_NAMES) expect(logLines.join('\n')).not.toContain(name);
  });
});

describe('unexpected failures', () => {
  it.each([
    ['/test/missing-table', 'missing table (SQL in the message)'],
    ['/test/bad-cast', 'invalid input (the value in the message)'],
    ['/test/raw-not-null', 'NOT NULL violation (the row in the detail)'],
    ['/test/wrapped', 'a CHECK violation wrapped as the cause of another error'],
    ['/test/exception', 'a plain exception with a path in its message'],
  ])('%s — %s: 500 INTERNAL_ERROR, generic text, no message or stack', async (url) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(500);
    expect(res.json<ProblemDetails>()).toEqual({
      type: 'about:blank',
      title: 'Something went wrong. The error has been logged.',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: expect.any(String) as string,
    });
    expect(leaks(res.body)).toEqual([]);
    expect(res.body).not.toMatch(/at .+\.(ts|js):\d+|\/Users\/|select /i);
  });

  it('the log keeps the SQLSTATE of database errors but never their message, detail or SQL', () => {
    const unhandled = logLines
      .map((l) => JSON.parse(l) as { msg?: string; err?: Record<string, unknown> })
      .filter((l) => l.msg === 'unhandled error');
    const pg = unhandled.filter((l) => typeof l.err?.severity === 'string');
    expect(pg.map((l) => l.err?.code).sort()).toEqual(['22P02', '23502', '42P01']);
    // The wrapped one: the wrapper keeps its own (code-authored) message; its cause is reduced.
    const wrapped = unhandled.find((l) => l.err?.message === 'loading the report failed');
    const cause = wrapped?.err?.cause as Record<string, unknown> | undefined;
    expect(cause).toMatchObject({ code: '23514', severity: 'ERROR', table: 'warehouses' });
    for (const fields of [...pg.map((l) => l.err ?? {}), cause ?? {}]) {
      for (const f of FORBIDDEN_PG_FIELDS) expect(fields, f).not.toHaveProperty(f);
    }
    for (const l of [...pg, wrapped]) {
      const text = JSON.stringify(l);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(SENTINEL.toLowerCase());
      expect(text).not.toContain(SECRET_TABLE);
      expect(text).not.toContain('Failing row');
      for (const name of CONSTRAINT_NAMES) expect(text).not.toContain(name);
    }
    // An ordinary exception keeps its message and stack for the operator (code-authored text).
    expect(unhandled).toContainEqual(
      expect.objectContaining({
        err: expect.objectContaining({
          type: 'Error',
          stack: expect.any(String) as string,
        }) as unknown,
      }),
    );
  });
});

describe('unknown routes', () => {
  it('404 has a fixed title: the requested path is not reflected back', async () => {
    for (const [method, url] of [
      ['GET', `/api/v1/${SENTINEL}/<script>`],
      ['POST', `/api/v1/${SENTINEL}?q=${SENTINEL}`],
      ['GET', `/${SENTINEL}.js`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json<ProblemDetails>()).toEqual({
        type: 'about:blank',
        title: 'Not found',
        status: 404,
        code: 'NOT_FOUND',
        requestId: expect.any(String) as string,
      });
      expect(res.body).not.toContain(SENTINEL);
    }
  });
});

describe('framework-level client errors', () => {
  it('malformed JSON is 400 with a fixed title: the parser output (with request fragments) is not echoed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: `{"username": ${SENTINEL}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ProblemDetails>()).toMatchObject({
      code: 'BAD_REQUEST',
      title: 'The request could not be read',
    });
    expect(res.body).not.toContain(SENTINEL);
  });

  it('an unsupported content type is 415 with a fixed title that does not echo the header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': `application/x-${SENTINEL.toLowerCase()}` },
      payload: 'x',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json<ProblemDetails>()).toMatchObject({
      code: 'BAD_REQUEST',
      title: 'Unsupported content type: send JSON',
    });
    expect(leaks(res.body)).toEqual([]);
  });
});

describe('failed background jobs', () => {
  it('administrators see a stable reason, not the database message; the log has no SQL', async () => {
    await env.services.db.transaction().execute((tx) =>
      enqueueOutbox(
        tx,
        [
          {
            topic: 'test.leaky',
            aggregateType: 'sales.invoice',
            aggregateId: crypto.randomUUID(),
            payload: {},
          },
        ],
        new Date(),
        fx.companyId,
      ),
    );
    const before = logLines.length;
    await new OutboxDispatcher({
      db: env.services.db,
      clock: fixedClock(new Date(Date.UTC(2031, 0, 1))),
      logger,
      handlers: {
        'test.leaky': {
          apply: async ({ tx }) => {
            await sql`select * from ${sql.raw(SECRET_TABLE)}`.execute(tx);
          },
        },
      },
      maxAttempts: 1,
    }).runOnce();

    const overview = await env.services.queries.execute(
      listOutboxEvents,
      { status: 'FAILED' },
      fx.actors.owner,
    );
    const job = overview.events.find((e) => e.topic === 'test.leaky');
    expect(job?.lastError).toBe(
      'The job failed (DatabaseError 42P01). Details are in the server log.',
    );
    const audit = await env.ownerDb
      .selectFrom('audit.events')
      .select('metadata')
      .where('command', '=', 'system.outbox.failed')
      .execute();
    expect(JSON.stringify(audit)).not.toContain(SECRET_TABLE);

    const logged = logLines.slice(before).join('\n');
    expect(logged).toContain('outbox event failed');
    expect(logged).toContain('42P01');
    expect(logged).not.toContain(SECRET_TABLE);
  });
});

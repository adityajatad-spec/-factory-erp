import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { QueryTimeoutError } from './errors';
import { defineQuery } from './queries';

/** QueryBus `timeoutMs`: a per-statement bound enforced by PostgreSQL (statement_timeout). */
let env: TestEnv;
let fx: Fixture;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const def = <R>(
  name: string,
  handler: Parameters<typeof defineQuery<z.ZodObject, R>>[0]['handler'],
) =>
  defineQuery({
    name,
    description: name,
    input: z.object({}),
    permission: PERMISSIONS.companyRead,
    ai: { tier: 'FORBIDDEN' },
    dataClass: 'INTERNAL',
    handler,
  });
const slow = def('test.slow', async ({ db }) => {
  await sql`select pg_sleep(5)`.execute(db);
  return 'finished';
});
const setting = def('test.setting', async ({ db }) => {
  const r = await sql<{ v: string }>`select current_setting('statement_timeout') as v`.execute(db);
  return r.rows[0]?.v ?? '';
});
const sleeping = async () => {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from pg_stat_activity
     where datname = current_database() and state = 'active'
       and pid <> pg_backend_pid() and query like '%pg_sleep(5)%'`.execute(env.ownerDb);
  return Number(r.rows[0]?.n ?? 0);
};

describe('statement time limit on queries', () => {
  it('PostgreSQL cancels a statement that runs past the limit; the caller gets QUERY_TIMEOUT', async () => {
    const t0 = Date.now();
    const err: unknown = await env.services.queries
      .execute(slow, {}, fx.actors.owner, { timeoutMs: 150 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(err).toMatchObject({ code: 'QUERY_TIMEOUT', httpStatus: 503 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    // Cancelled by the server, not merely abandoned by us: nothing is still running.
    expect(await sleeping()).toBe(0);
  });

  it('applies only inside that query: pooled connections never keep the limit', async () => {
    expect(
      await env.services.queries.execute(setting, {}, fx.actors.owner, { timeoutMs: 1234 }),
    ).toBe('1234ms');
    // More parallel reads than the pool has connections, so every connection is checked.
    const values = await Promise.all(
      Array.from({ length: 12 }, () => env.services.queries.execute(setting, {}, fx.actors.owner)),
    );
    expect(new Set(values)).toEqual(new Set(['0']));
  });

  it('a timed-out query leaves the pool healthy, and fast queries pass under the limit', async () => {
    await env.services.queries
      .execute(slow, {}, fx.actors.owner, { timeoutMs: 50 })
      .catch(() => undefined);
    expect(
      await env.services.queries.execute(setting, {}, fx.actors.owner, { timeoutMs: 5_000 }),
    ).toBe('5s');
  });
});

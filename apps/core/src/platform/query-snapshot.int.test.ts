import { PERMISSIONS } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { salesFlows } from '../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import type { Database } from '../db/database';
import { getReceivablesSummary } from '../modules/receivables';
import { defineQuery } from './queries';

/**
 * Every query runs in one read-only, repeatable-read snapshot (Slice 0, task 10). A report
 * that reads several tables can therefore never combine figures from two moments — e.g.
 * receipts counted before a payment and allocations counted after it.
 */
const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const receiptCount = async (db: Database) =>
  Number(
    (await sql<{ n: string }>`select count(*) as n from finance.receipts`.execute(db)).rows[0]?.n,
  );

describe('query snapshots', () => {
  it('two reads in one query see the same data even if a payment commits in between', async () => {
    let between: () => Promise<void> = () => Promise.resolve();
    const twoReads = defineQuery({
      name: 'test.twoReads',
      description: 'test',
      input: z.object({}),
      permission: PERMISSIONS.companyRead,
      ai: { tier: 'FORBIDDEN' },
      dataClass: 'INTERNAL',
      handler: async ({ db }) => {
        const first = await receiptCount(db);
        await between();
        return { first, second: await receiptCount(db) };
      },
    });
    between = async () => {
      await f.receipt('100.00'); // commits on another connection mid-query
    };
    const { first, second } = await env.services.queries.execute(twoReads, {}, fx.actors.owner);
    expect(second).toBe(first);
    expect(await receiptCount(env.services.db)).toBe(first + 1);
  });

  it('a query cannot write, even by mistake', async () => {
    const sneaky = defineQuery({
      name: 'test.sneakyWrite',
      description: 'test',
      input: z.object({}),
      permission: PERMISSIONS.companyRead,
      ai: { tier: 'FORBIDDEN' },
      dataClass: 'INTERNAL',
      handler: async ({ db }) => {
        await sql`update platform.states set name = name where code = '27'`.execute(db);
        return null;
      },
    });
    await expect(env.services.queries.execute(sneaky, {}, fx.actors.owner)).rejects.toMatchObject({
      code: '25006', // read_only_sql_transaction
    });
  });

  it('the receivables report reconciles while payments are being recorded', async () => {
    const inv = await f.issued('8474.58');
    const writes = (async () => {
      for (let i = 0; i < 15; i++) {
        await f.receipt('10.00', i % 2 ? [{ invoiceId: inv.id, amount: '10.00' }] : []);
      }
    })();
    const reads = (async () => {
      for (let i = 0; i < 15; i++) {
        const s = await env.services.queries.execute(
          getReceivablesSummary,
          {},
          fx.actors.accountant,
        );
        for (const row of [s.totals, ...s.customers]) {
          // balance (ledger) = bill-wise outstanding − money not yet allocated
          expect(
            Money.of(row.outstandingAmount).minus(Money.of(row.unallocatedAmount)).toString(),
          ).toBe(Money.of(row.balance).toString());
        }
      }
    })();
    await Promise.all([writes, reads]);
  });
});

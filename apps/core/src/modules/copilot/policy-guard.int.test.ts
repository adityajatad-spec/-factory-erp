import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { DB } from '../../db/schema.generated';
import { uuidv7 } from '../../platform/ids';
import { setAiPolicy } from './index';

/**
 * The database guard on ai.policy_versions (migration 0015), exercised through real inserts —
 * mostly as the application's least-privilege runtime role, i.e. as any code path that tried to
 * write policy history around the ai.policy.set command.
 */
let env: TestEnv;
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  env = await createTestEnv();
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' });
});
afterAll(async () => env.destroy());

const insert = (
  db: Kysely<DB>,
  row: { companyId: string; version: number; createdBy: string; aiEnabled?: boolean },
) =>
  sql`insert into ai.policy_versions (company_id, version, ai_enabled, tasks, reason, created_at, created_by)
      values (${row.companyId}, ${row.version}, ${row.aiEnabled ?? true}, '{}'::jsonb,
              'direct insert', now(), ${row.createdBy})`.execute(db);
const versions = async (companyId: string) =>
  (
    await env.ownerDb
      .selectFrom('ai.policyVersions')
      .select('version')
      .where('companyId', '=', companyId)
      .orderBy('version')
      .execute()
  ).map((r) => r.version);
const runtime = () => env.services.db;
const rejected = { code: 'FO007' };

describe('ai.policy_versions insert guard (database trigger)', () => {
  it('accepts the next version created by an active owner of that company', async () => {
    await insert(runtime(), {
      companyId: A.companyId,
      version: 1,
      createdBy: A.actors.owner.user.id,
    });
    expect(await versions(A.companyId)).toEqual([1]);
  });

  it('refuses a creator who is not an owner of the company (runtime role)', async () => {
    for (const actor of [A.actors.admin, A.actors.accountant, A.actors.worker]) {
      await expect(
        insert(runtime(), { companyId: A.companyId, version: 2, createdBy: actor.user.id }),
      ).rejects.toMatchObject(rejected);
    }
    expect(await versions(A.companyId)).toEqual([1]);
  });

  it("refuses another company's owner", async () => {
    await expect(
      insert(runtime(), { companyId: A.companyId, version: 2, createdBy: B.actors.owner.user.id }),
    ).rejects.toMatchObject(rejected);
    expect(await versions(A.companyId)).toEqual([1]);
  });

  it('refuses a deactivated owner', async () => {
    const id = uuidv7();
    await env.ownerDb
      .insertInto('identity.users')
      .values({
        id,
        username: `former-owner-${id.slice(-8)}`,
        displayName: 'Former owner',
        passwordHash: 'x',
        status: 'DISABLED',
      })
      .execute();
    await env.ownerDb
      .insertInto('identity.userRoles')
      .values({ userId: id, roleCode: 'OWNER', companyId: A.companyId })
      .execute();
    await expect(
      insert(runtime(), { companyId: A.companyId, version: 2, createdBy: id }),
    ).rejects.toMatchObject(rejected);
  });

  it('refuses a version gap, a repeated version and version 0', async () => {
    const owner = A.actors.owner.user.id;
    for (const version of [3, 7, 1]) {
      await expect(
        insert(runtime(), { companyId: A.companyId, version, createdBy: owner }),
      ).rejects.toMatchObject(rejected);
    }
    await expect(
      insert(runtime(), { companyId: A.companyId, version: 0, createdBy: owner }),
    ).rejects.toThrow();
    expect(await versions(A.companyId)).toEqual([1]);
  });

  it('binds even the schema owner', async () => {
    await expect(
      insert(env.ownerDb, {
        companyId: A.companyId,
        version: 2,
        createdBy: A.actors.accountant.user.id,
      }),
    ).rejects.toMatchObject(rejected);
  });

  it('two concurrent inserts of the same next version: exactly one lands', async () => {
    const attempt = () =>
      runtime()
        .transaction()
        .execute(async (tx) => {
          await insert(tx, {
            companyId: A.companyId,
            version: 2,
            createdBy: A.actors.owner.user.id,
          });
          await sql`select pg_sleep(0.2)`.execute(tx); // hold the lock while the other waits
        });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect(r.reason).toMatchObject(rejected);
    expect(await versions(A.companyId)).toEqual([1, 2]);
  });

  it('the command path still works on top of the guard, continuing the sequence', async () => {
    const v3 = await env.services.commands.execute(
      setAiPolicy,
      { expectedVersion: 2, aiEnabled: false, tasks: {}, reason: 'Owner switches AI off' },
      A.actors.owner,
    );
    expect(v3).toMatchObject({ version: 3, aiEnabled: false });
    expect(await versions(A.companyId)).toEqual([1, 2, 3]);
  });

  it('history stays append-only for the runtime role', async () => {
    await expect(
      sql`update ai.policy_versions set ai_enabled = true where company_id = ${A.companyId}`.execute(
        runtime(),
      ),
    ).rejects.toThrow();
    await expect(
      sql`delete from ai.policy_versions where company_id = ${A.companyId}`.execute(runtime()),
    ).rejects.toThrow();
    await expect(sql`truncate ai.policy_versions`.execute(runtime())).rejects.toThrow();
    expect(await versions(A.companyId)).toEqual([1, 2, 3]);
  });
});

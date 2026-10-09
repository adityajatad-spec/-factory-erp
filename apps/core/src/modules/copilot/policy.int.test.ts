import type { AiCallContext } from '@factory-erp/ai';
import { PERMISSIONS, type Permission, type SetAiPolicyRequest } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { FAKE_MODEL_ID } from '../../ai/fake-provider';
import { policyContent, resolveCompanyPolicy } from '../../ai/policy-resolver';
import { createAiService } from '../../ai/service';
import { AI_DISABLED } from '../../config';
import type { AuthenticatedActor } from '../../platform/actor';
import { ForbiddenError, ValidationError, VersionConflictError } from '../../platform/errors';
import { DEFAULT_ROLES } from '../../platform/roles';
import { loadAccess } from '../identity';
import { getAiPolicy, setAiPolicy } from './index';

let env: TestEnv;
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  env = await createTestEnv();
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' });
});
afterAll(async () => env.destroy());

const body = (over: Partial<SetAiPolicyRequest> = {}): SetAiPolicyRequest => ({
  expectedVersion: 0,
  aiEnabled: true,
  tasks: {
    'copilot.answer': {
      maxDataClass: 'CONFIDENTIAL',
      approvedModels: [{ modelId: FAKE_MODEL_ID, p95LatencyMs: 1000 }],
      fallback: false,
    },
  },
  reason: 'Enable the local copilot',
  ...over,
});
const set = (actor: AuthenticatedActor, over: Partial<SetAiPolicyRequest> = {}) =>
  env.services.commands.execute(setAiPolicy, body(over), actor);
const versions = async (companyId: string) =>
  (
    await env.ownerDb
      .selectFrom('ai.policyVersions')
      .select('version')
      .where('companyId', '=', companyId)
      .orderBy('version')
      .execute()
  ).map((r) => r.version);
const policyAudits = (companyId: string) =>
  env.ownerDb
    .selectFrom('audit.events')
    .select(['command', 'before', 'after', 'actorUserId'])
    .where('entityType', '=', 'ai.policy')
    .where('companyId', '=', companyId)
    .orderBy('occurredAt')
    .execute();

describe('AI policy — who may change it', () => {
  it('ADMIN does not get ai.policy.manage: not by default roles, not by role synchronisation', async () => {
    expect(DEFAULT_ROLES.ADMIN.permissions).not.toContain(PERMISSIONS.aiPolicyManage);
    expect(DEFAULT_ROLES.OWNER.permissions).toContain(PERMISSIONS.aiPolicyManage);
    const stored = await env.ownerDb
      .selectFrom('identity.rolePermissions')
      .select('roleCode')
      .where('permission', '=', PERMISSIONS.aiPolicyManage)
      .execute();
    expect(stored.map((r) => r.roleCode)).toEqual(['OWNER']);
    const access = await loadAccess(env.services.db, A.actors.admin.user.id, A.companyId);
    expect(access.permissions.has(PERMISSIONS.aiPolicyManage)).toBe(false);
  });

  it('ADMIN, ACCOUNTANT and the AI actor are refused; nothing is written', async () => {
    await expect(set(A.actors.admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(set(A.actors.accountant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(set(asAiAgent(A.actors.owner))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await versions(A.companyId)).toEqual([]);
  });

  it('even holding the permission, a non-OWNER is refused by the role check', async () => {
    const admin = A.actors.admin;
    const elevated: AuthenticatedActor = {
      ...admin,
      user: {
        ...admin.user,
        permissions: new Set<Permission>([...admin.user.permissions, PERMISSIONS.aiPolicyManage]),
      },
    };
    await expect(set(elevated)).rejects.toThrow(/OWNER role/);
    expect(await versions(A.companyId)).toEqual([]);
  });

  it('the AI actor cannot even read the policy', async () => {
    await expect(
      env.services.queries.execute(getAiPolicy, {}, asAiAgent(A.actors.owner)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AI policy — versions, validation and audit', () => {
  it('fails closed before any policy exists', async () => {
    expect(await env.services.queries.execute(getAiPolicy, {}, A.actors.owner)).toBeNull();
    expect(await resolveCompanyPolicy(env.services.queries, A.actors.owner)).toEqual({
      ok: false,
      reason: 'POLICY_MISSING',
      version: null,
    });
  });

  it('the owner sets version 1; it is stored, readable, resolvable and audited before/after', async () => {
    const v1 = await set(A.actors.owner);
    expect(v1).toMatchObject({
      companyId: A.companyId,
      version: 1,
      aiEnabled: true,
      locality: 'LOCAL_ONLY',
      cloudEnabled: false,
      reason: 'Enable the local copilot',
    });
    const r = await resolveCompanyPolicy(env.services.queries, A.actors.worker);
    expect(r.ok && r.policy.version).toBe(1);
    const audits = await policyAudits(A.companyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      command: 'ai.policy.set',
      before: null,
      after: {
        version: 1,
        aiEnabled: true,
        cloudEnabled: false,
        reason: 'Enable the local copilot',
      },
      actorUserId: A.actors.owner.user.id,
    });
  });

  it('a stale expectedVersion is a version conflict, and changes nothing', async () => {
    await expect(set(A.actors.owner, { expectedVersion: 0 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    await expect(set(A.actors.owner, { expectedVersion: 7 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect(await versions(A.companyId)).toEqual([1]);
    expect(await policyAudits(A.companyId)).toHaveLength(1);
  });

  it('concurrent updates from the same version: exactly one succeeds', async () => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) =>
        set(A.actors.owner, { expectedVersion: 1, reason: `Concurrent change ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect(r.reason).toBeInstanceOf(VersionConflictError);
    expect(await versions(A.companyId)).toEqual([1, 2]);
  });

  it.each([
    [
      'RESTRICTED data',
      {
        tasks: {
          'copilot.answer': { ...body().tasks['copilot.answer']!, maxDataClass: 'RESTRICTED' },
        },
      },
    ],
    ['an unsupported task', { tasks: { 'doc.extract': body().tasks['copilot.answer'] } }],
    ['cloud inference', { cloudEnabled: true }],
    ['a non-local locality', { locality: 'HYBRID' }],
    ['a company chosen by the request', { companyId: '01900000-0000-7000-8000-0000000000bb' }],
    ['a version chosen by the request', { version: 99 }],
    ['an unknown field', { allowEverything: true }],
    ['a missing reason', { reason: '  ' }],
  ])('rejects %s, writing nothing', async (_label, over) => {
    await expect(
      set(A.actors.owner, { ...over, expectedVersion: 2 } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await versions(A.companyId)).toEqual([1, 2]);
  });

  it('a failure after the lock and the read rolls back: no version and no audit event', async () => {
    const auditsBefore = (await policyAudits(A.companyId)).length;
    // An owner whose user row does not exist: the insert's foreign key fails mid-command.
    const ghost: AuthenticatedActor = {
      ...A.actors.owner,
      user: { ...A.actors.owner.user, id: '01900000-0000-7000-8000-0000000000ff' },
    };
    await expect(set(ghost, { expectedVersion: 2 })).rejects.toThrow();
    expect(await versions(A.companyId)).toEqual([1, 2]);
    expect(await policyAudits(A.companyId)).toHaveLength(auditsBefore);
  });
});

describe('AI policy — append-only in the database', () => {
  it('the application role cannot update, delete or truncate policy history', async () => {
    const db = env.services.db;
    await expect(
      sql`update ai.policy_versions set ai_enabled = false where company_id = ${A.companyId}`.execute(
        db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`delete from ai.policy_versions where company_id = ${A.companyId}`.execute(db),
    ).rejects.toThrow();
    await expect(sql`truncate ai.policy_versions`.execute(db)).rejects.toThrow();
  });

  it('even the schema owner cannot edit history, and SQL refuses cloud or RESTRICTED rows', async () => {
    await expect(
      sql`update ai.policy_versions set ai_enabled = false where company_id = ${A.companyId}`.execute(
        env.ownerDb,
      ),
    ).rejects.toMatchObject({ code: 'FO001' });
    const insert = (cloud: boolean, tasks: string) =>
      sql`insert into ai.policy_versions (company_id, version, ai_enabled, cloud_enabled, tasks, reason, created_at, created_by)
          values (${A.companyId}, 3, true, ${cloud}, ${tasks}::jsonb, 'raw', now(), ${A.actors.owner.user.id})`.execute(
        env.ownerDb,
      );
    await expect(insert(true, '{}')).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        false,
        '{"copilot.answer":{"maxDataClass":"RESTRICTED","approvedModels":[],"fallback":false}}',
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await versions(A.companyId)).toEqual([1, 2]);
  });
});

describe('AI policy — company isolation and fail-closed resolution', () => {
  it("each company resolves only its own policy; B's owner cannot touch A's", async () => {
    expect((await resolveCompanyPolicy(env.services.queries, B.actors.owner)).ok).toBe(false);
    const bv1 = await set(B.actors.owner, { aiEnabled: false, reason: 'Bravo keeps AI off' });
    expect(bv1).toMatchObject({ companyId: B.companyId, version: 1, aiEnabled: false });
    expect(await versions(A.companyId)).toEqual([1, 2]);
    const a = await resolveCompanyPolicy(env.services.queries, A.actors.owner);
    const b = await resolveCompanyPolicy(env.services.queries, B.actors.owner);
    expect(a.ok && a.policy.companyId).toBe(A.companyId);
    expect(b.ok && b.policy.companyId).toBe(B.companyId);
  });

  it("A's stored policy is refused when presented for B", async () => {
    const stored = await env.services.queries.execute(getAiPolicy, {}, A.actors.owner);
    const { resolveAiPolicy } = await import('@factory-erp/ai');
    expect(resolveAiPolicy(policyContent(stored), A.companyId).ok).toBe(true);
    expect(resolveAiPolicy(policyContent(stored), B.companyId)).toEqual({
      ok: false,
      reason: 'POLICY_COMPANY_MISMATCH',
    });
  });

  it('the resolver refuses to act for an AI actor, and fails closed on a corrupt stored row', async () => {
    expect(await resolveCompanyPolicy(env.services.queries, asAiAgent(A.actors.owner))).toEqual({
      ok: false,
      reason: 'POLICY_UNAVAILABLE',
      version: null,
    });
    // A row that passes the SQL checks but not the contract (missing task fields).
    await sql`insert into ai.policy_versions (company_id, version, ai_enabled, tasks, reason, created_at, created_by)
              values (${B.companyId}, 2, true, '{"copilot.answer":{"maxDataClass":"CONFIDENTIAL"}}'::jsonb,
                      'corrupt', now(), ${B.actors.owner.user.id})`.execute(env.ownerDb);
    expect(await resolveCompanyPolicy(env.services.queries, B.actors.owner)).toEqual({
      ok: false,
      reason: 'POLICY_INVALID',
      version: null,
    });
  });
});

describe('AI policy — drives the gateway, re-resolved for every call', () => {
  it('approved model answers; after the owner switches AI off, the very next call is blocked', async () => {
    const ai = createAiService({ ...AI_DISABLED, provider: 'fake' });
    const call = async () => {
      const r = await resolveCompanyPolicy(env.services.queries, A.actors.owner);
      const ctx: AiCallContext = {
        task: 'copilot.answer',
        policy: r.ok ? r.policy : null,
        dataClass: 'INTERNAL',
        companyId: A.actors.owner.user.companyId,
        userId: A.actors.owner.user.id,
        aiSessionId: 's',
      };
      return ai.gateway?.generate(ctx, {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      });
    };
    expect(await call()).toMatchObject({
      ok: true,
      served: { modelId: FAKE_MODEL_ID, policyVersion: 2 },
    });
    await set(A.actors.owner, { expectedVersion: 2, aiEnabled: false, reason: 'Switch AI off' });
    expect(await call()).toEqual({ ok: false, reason: 'POLICY_BLOCKED', policyVersion: 3 });
  });
});

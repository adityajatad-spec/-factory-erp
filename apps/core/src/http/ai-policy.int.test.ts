import type { AiPolicyViewDto, ProblemDetails } from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, TEST_PASSWORD, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { AI_DISABLED } from '../config';
import { buildApp } from './app';

/**
 * The AI policy over HTTP, through the real app, session cookies and error handler. A local
 * runtime is configured but never reachable: every call to it is counted.
 */
let env: TestEnv;
let fx: Fixture;
let app: FastifyInstance;
let providerCalls = 0;
let key = 0;
const idem = () => ({ 'idempotency-key': `policy-route-${Date.now()}-${++key}` });

beforeAll(async () => {
  env = await createTestEnv({
    ai: {
      config: { ...AI_DISABLED, provider: 'ollama', model: 'qwen2.5:7b', healthTimeoutMs: 300 },
      options: {
        fetch: () => {
          providerCalls++;
          return Promise.reject(new TypeError('fetch failed'));
        },
      },
    },
  });
  fx = await createFixture(env.services);
  app = await buildApp(env.services);
});
afterAll(async () => {
  await app.close();
  await env.destroy();
});

/** One sign-in per user (the login rate limit is real here); sessions re-read user flags. */
const cookies = new Map<string, string>();
async function cookieFor(username: string): Promise<string> {
  const cached = cookies.get(username);
  if (cached) return cached;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const cookie = `ferp_session=${res.cookies.find((c) => c.name === 'ferp_session')?.value ?? ''}`;
  cookies.set(username, cookie);
  return cookie;
}
const policyBody = (over: Record<string, unknown> = {}) => ({
  expectedVersion: 0,
  aiEnabled: true,
  tasks: {
    'copilot.answer': {
      maxDataClass: 'CONFIDENTIAL',
      approvedModels: [{ modelId: 'ollama:qwen2.5:7b', p95LatencyMs: 20_000 }],
      fallback: false,
    },
  },
  reason: 'Enable the local copilot',
  ...over,
});
const put = (cookie: string | null, payload: unknown, headers: Record<string, string> = idem()) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1/ai/policy',
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload: payload as Record<string, unknown>,
  });
const versionsStored = async () =>
  (
    await env.ownerDb
      .selectFrom('ai.policyVersions')
      .select('version')
      .where('companyId', '=', fx.companyId)
      .execute()
  ).length;

describe('PUT /api/v1/ai/policy', () => {
  it('refuses unauthenticated, ADMIN and ACCOUNTANT callers', async () => {
    expect((await put(null, policyBody())).statusCode).toBe(401);
    for (const who of [fx.actors.admin, fx.actors.accountant, fx.actors.worker]) {
      const res = await put(await cookieFor(who.user.username), policyBody());
      expect(res.statusCode, who.user.username).toBe(403);
      expect(res.json<ProblemDetails>().code).toBe('FORBIDDEN');
    }
    expect(await versionsStored()).toBe(0);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await put(await cookieFor(fx.actors.owner.user.username), policyBody(), {});
    expect(res.statusCode).toBe(400);
    expect(res.json<ProblemDetails>().issues?.[0]?.path).toBe('Idempotency-Key');
    expect(await versionsStored()).toBe(0);
  });

  it('refuses a client-chosen company or version', async () => {
    const cookie = await cookieFor(fx.actors.owner.user.username);
    for (const extra of [{ companyId: fx.companyId }, { version: 5 }, { cloudEnabled: true }]) {
      const res = await put(cookie, policyBody(extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json<ProblemDetails>().code).toBe('VALIDATION_FAILED');
    }
    expect(await versionsStored()).toBe(0);
  });

  it('lets the OWNER set version 1, then answers a stale expectedVersion with 409', async () => {
    const cookie = await cookieFor(fx.actors.owner.user.username);
    const ok = await put(cookie, policyBody());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: 1, aiEnabled: true, companyId: fx.companyId });
    const stale = await put(cookie, policyBody({ expectedVersion: 0, reason: 'Second try' }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ProblemDetails>().code).toBe('VERSION_CONFLICT');
    expect(await versionsStored()).toBe(1);
  });
});

describe('GET /api/v1/ai/policy — what each person may see', () => {
  it('everyone sees whether AI is on and the data ceiling; never models, latency, reason or editor', async () => {
    for (const who of [fx.actors.worker, fx.actors.accountant, fx.actors.admin]) {
      const res = await app.inject({
        url: '/api/v1/ai/policy',
        headers: { cookie: await cookieFor(who.user.username) },
      });
      expect(res.statusCode).toBe(200);
      const view = res.json<AiPolicyViewDto>();
      expect(view).toMatchObject({
        version: 1,
        aiEnabled: true,
        locality: 'LOCAL_ONLY',
        cloudEnabled: false,
        valid: true,
        tasks: [{ task: 'copilot.answer', maxDataClass: 'CONFIDENTIAL' }],
        detail: null,
      });
      expect(res.body).not.toMatch(/qwen|p95|approvedModels|Enable the local copilot|owner/);
    }
  });

  it('the owner also gets the detail needed to change it', async () => {
    const res = await app.inject({
      url: '/api/v1/ai/policy',
      headers: { cookie: await cookieFor(fx.actors.owner.user.username) },
    });
    expect(res.json<AiPolicyViewDto>().detail).toMatchObject({
      reason: 'Enable the local copilot',
      createdByName: fx.actors.owner.user.displayName,
      tasks: { 'copilot.answer': { approvedModels: [{ modelId: 'ollama:qwen2.5:7b' }] } },
    });
  });

  it('a company without a policy gets JSON null (the web app reads it as "no policy")', async () => {
    const other = await createFixture(env.services, { tag: 'nopolicy' });
    const res = await app.inject({
      url: '/api/v1/ai/policy',
      headers: { cookie: await cookieFor(other.actors.owner.user.username) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toBeNull();
  });

  it('requires a signed-in user', async () => {
    expect((await app.inject('/api/v1/ai/policy')).statusCode).toBe(401);
  });
});

describe('GET /api/v1/ai/status — forced password change', () => {
  it('is refused before any provider check while the user must change their password', async () => {
    await env.ownerDb
      .updateTable('identity.users')
      .set({ mustChangePassword: true })
      .where('id', '=', fx.actors.worker.user.id)
      .execute();
    const cookie = await cookieFor(fx.actors.worker.user.username);
    const before = providerCalls;
    const res = await app.inject({ url: '/api/v1/ai/status', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json<ProblemDetails>().code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(providerCalls).toBe(before);

    // A user who need not change their password does trigger the (bounded) check.
    const owner = await cookieFor(fx.actors.owner.user.username);
    const ok = await app.inject({ url: '/api/v1/ai/status', headers: { cookie: owner } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      state: 'UNAVAILABLE',
      policy: { state: 'ENABLED', version: 1 },
    });
    expect(providerCalls).toBeGreaterThan(before);
  });
});

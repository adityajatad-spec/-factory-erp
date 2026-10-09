import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, TEST_PASSWORD } from '../../test/fixtures';
import { createTestEnv } from '../../test/test-db';
import type { AiStatusResponse } from './ai-routes';
import { AI_DISABLED } from '../config';
import { buildApp } from './app';

/** Each environment gets its own app; Ollama is never contacted (injected HTTP client). */
type AiOverride = NonNullable<Parameters<typeof createTestEnv>[0]>['ai'];

async function start(ai: AiOverride) {
  const env = await createTestEnv(ai ? { ai } : {});
  const fx = await createFixture(env.services);
  const app = await buildApp(env.services);
  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return `ferp_session=${res.cookies.find((c) => c.name === 'ferp_session')?.value ?? ''}`;
  };
  return { env, fx, app, login };
}
type Started = Awaited<ReturnType<typeof start>>;

let ollamaDown: Started;
let disabled: Started;
let fetchCalls = 0;

beforeAll(async () => {
  ollamaDown = await start({
    config: { ...AI_DISABLED, provider: 'ollama', model: 'qwen2.5:7b', healthTimeoutMs: 300 },
    options: {
      fetch: () => {
        fetchCalls++;
        return Promise.reject(new TypeError('fetch failed')); // ECONNREFUSED, as when stopped
      },
    },
  });
  disabled = await start(undefined);
});
afterAll(async () => {
  for (const s of [ollamaDown, disabled]) {
    await s.app.close();
    await s.env.destroy();
  }
});

describe('the ERP does not depend on the local AI runtime', () => {
  it('starts and serves ordinary routes while Ollama is configured but stopped', async () => {
    expect(fetchCalls).toBe(0); // startup made no AI call
    expect((await ollamaDown.app.inject('/api/v1/health')).statusCode).toBe(200);
    const cookie = await ollamaDown.login(ollamaDown.fx.actors.accountant.user.username);
    const parties = await ollamaDown.app.inject({ url: '/api/v1/parties', headers: { cookie } });
    expect(parties.statusCode).toBe(200);
    const dashboard = await ollamaDown.app.inject({
      url: '/api/v1/dashboard',
      headers: { cookie },
    });
    expect(dashboard.statusCode).toBe(200);
  });
});

describe('GET /api/v1/ai/status', () => {
  it('requires a signed-in user', async () => {
    expect((await ollamaDown.app.inject('/api/v1/ai/status')).statusCode).toBe(401);
  });

  it('reports UNAVAILABLE with a coded reason — and no internal URL — when Ollama is down', async () => {
    const cookie = await ollamaDown.login(ollamaDown.fx.actors.worker.user.username);
    const res = await ollamaDown.app.inject({ url: '/api/v1/ai/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const s = res.json<AiStatusResponse>();
    expect(s).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'UNREACHABLE',
      providerId: 'ollama',
      locality: 'LOCAL',
      policy: { state: 'NONE', version: null }, // no policy stored: AI off
    });
    expect(res.body).not.toMatch(/11434|127\.0\.0\.1|http:/);
    // The model identifier is a deployment detail: not published to every signed-in user.
    expect(Object.keys(s).sort()).toEqual([
      'checkedAt',
      'locality',
      'policy',
      'providerId',
      'reason',
      'state',
    ]);
    expect(res.body).not.toMatch(/qwen|modelId/);
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it('reports DISABLED when AI is not configured', async () => {
    const cookie = await disabled.login(disabled.fx.actors.owner.user.username);
    const res = await disabled.app.inject({ url: '/api/v1/ai/status', headers: { cookie } });
    expect(res.json<AiStatusResponse>()).toMatchObject({ state: 'DISABLED', providerId: null });
  });
});

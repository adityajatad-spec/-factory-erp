import { resolveAiPolicy, type AiCallContext, type ResolvedAiPolicy } from '@factory-erp/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_MODEL_ID } from './fake-provider';
import type { FetchLike } from './ollama';
import { createAiService, type AiSettings } from './service';

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  provider: 'fake',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: null,
  contextTokens: 8192,
  timeoutMs: 1000,
  healthTimeoutMs: 200,
  ...over,
});

const COMPANY = '01900000-0000-7000-8000-00000000000c';

/** A resolved company policy (the real one will come from the database in a later increment). */
function policy(approved: string[] = [FAKE_MODEL_ID], version = 7): ResolvedAiPolicy {
  const r = resolveAiPolicy(
    {
      companyId: COMPANY,
      version,
      aiEnabled: true,
      locality: 'LOCAL_ONLY',
      cloudEnabled: false,
      tasks: {
        'copilot.answer': {
          maxDataClass: 'CONFIDENTIAL',
          approvedModels: approved.map((modelId) => ({ modelId, p95LatencyMs: 10 })),
          fallback: false,
        },
      },
    },
    COMPANY,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.policy;
}
const ctx = (p: ResolvedAiPolicy | null = policy()): AiCallContext => ({
  task: 'copilot.answer',
  policy: p,
  dataClass: 'INTERNAL',
  companyId: COMPANY,
  userId: 'u',
  aiSessionId: 's',
});
const hello = {
  messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] }],
};

// Automated tests must never touch the network: fail loudly if anything reaches real fetch.
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(() => Promise.reject(new Error('network used in a unit test')));
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('AI service — configuration and status', () => {
  it('AI off: no gateway, status DISABLED, and nothing is ever contacted', async () => {
    const ai = createAiService(settings({ provider: 'none' }));
    expect(ai.enabled).toBe(false);
    expect(ai.gateway).toBeNull();
    expect(await ai.check()).toMatchObject({ state: 'DISABLED', providerId: null, modelId: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('configured but not yet checked: construction makes no call', () => {
    const calls: string[] = [];
    const fetchSpy: FetchLike = (url) => {
      calls.push(url);
      return Promise.reject(new Error('down'));
    };
    const ai = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: fetchSpy,
    });
    expect(ai.peek()).toMatchObject({
      state: 'NOT_CHECKED',
      providerId: 'ollama',
      modelId: 'ollama:qwen2.5:7b',
      locality: 'LOCAL',
      checkedAt: null,
    });
    expect(calls).toEqual([]);
  });

  it('reports UNAVAILABLE with a coded reason when Ollama is down or the model is missing', async () => {
    const down = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const s = await down.check();
    expect(s).toMatchObject({ state: 'UNAVAILABLE', reason: 'UNREACHABLE' });
    expect(s.checkedAt).not.toBeNull();
    expect(JSON.stringify(s)).not.toContain('11434'); // no internal URL in the status

    const noModel = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: () =>
        Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"models":[]}') }),
    });
    expect(await noModel.check()).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'MODEL_NOT_INSTALLED',
    });
  });

  it('reports REACHABLE only after a successful check', async () => {
    const ai = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"models":[{"name":"qwen2.5:7b"}]}'),
        }),
    });
    expect(ai.peek().state).toBe('NOT_CHECKED');
    expect(await ai.check()).toMatchObject({ state: 'REACHABLE', reason: null });
    expect(ai.peek().state).toBe('REACHABLE');
  });

  it('a check that never answers is still bounded', async () => {
    const ai = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: () => new Promise(() => undefined),
    });
    const started = Date.now();
    expect((await ai.check()).state).toBe('UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('AI service — invocation through the gateway (fake provider)', () => {
  it('fails closed without a company policy: nothing is routed, nothing is called', async () => {
    const ai = createAiService(settings());
    expect(ai.peek()).toMatchObject({ policy: { state: 'NOT_RESOLVED', version: null } });
    expect(await ai.gateway?.generate(ctx(null), hello)).toEqual({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
  });

  it('with an approving policy, the fake model answers deterministically, locally, usage unknown', async () => {
    const ai = createAiService(settings());
    expect((await ai.check()).state).toBe('REACHABLE');
    const r = await ai.gateway?.generate(ctx(), hello);
    expect(r).toMatchObject({
      ok: true,
      value: { text: 'Fake reply: hello', toolCalls: [] },
      served: {
        providerId: 'fake',
        modelId: FAKE_MODEL_ID,
        locality: 'LOCAL',
        inputTokens: null,
        outputTokens: null,
        costMicroInr: 0n,
        policyVersion: 7,
      },
    });
  });

  it('configuring a model is not approving it: the policy must name it', async () => {
    const calls: string[] = [];
    const ai = createAiService(settings({ provider: 'ollama', model: 'qwen2.5:7b' }), {
      fetch: (url) => {
        calls.push(url);
        return Promise.reject(new Error('must not be called'));
      },
    });
    expect(await ai.gateway?.generate(ctx(policy(['ollama:some-other-model'])), hello)).toEqual({
      ok: false,
      reason: 'POLICY_BLOCKED',
      policyVersion: 7,
    });
    expect(calls).toEqual([]);
  });

  it('the policy still binds: data above its class is refused even with a healthy model', async () => {
    const ai = createAiService(settings());
    expect(await ai.gateway?.generate({ ...ctx(), dataClass: 'RESTRICTED' }, hello)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
  });

  it('an unavailable provider and a provider that hangs give typed failures', async () => {
    const down = createAiService(settings(), { fakeBehaviour: 'unavailable' });
    expect(await down.check()).toMatchObject({ state: 'UNAVAILABLE', reason: 'UNREACHABLE' });
    expect(await down.gateway?.generate(ctx(), hello)).toMatchObject({
      ok: false,
      reason: 'AI_UNAVAILABLE',
    });

    const slow = createAiService(settings({ timeoutMs: 1000 }), { fakeBehaviour: 'hang' });
    expect(await slow.gateway?.generate(ctx(), hello)).toMatchObject({
      ok: false,
      reason: 'TIMEOUT',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

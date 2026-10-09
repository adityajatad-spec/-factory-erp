import {
  ProviderError,
  resolveAiPolicy,
  type AiCallContext,
  type ModelInfo,
  type NormalizedResponse,
  type ResolvedAiPolicy,
  type ProviderAdapter,
} from '@factory-erp/ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAiGateway } from './gateway';
import { ollamaAdapter, type FetchLike } from './ollama';

const model = (
  id: string,
  providerId: string,
  locality: 'LOCAL' | 'CLOUD' = 'LOCAL',
): ModelInfo => ({
  id,
  providerId,
  locality,
  capabilities: ['chat', 'tools', 'structured'],
  contextTokens: 32_000,
  priceInPerMTokMicroInr: 0n,
  priceOutPerMTokMicroInr: 0n,
});

const COMPANY = '01900000-0000-7000-8000-00000000000c';
const OTHER_COMPANY = '01900000-0000-7000-8000-00000000000d';

/** A resolved company policy approving the given models for the copilot. */
function policy(
  approved: string[] = ['local:m', 'local:a', 'local:b', 'cloud:big'],
  over: { version?: number; aiEnabled?: boolean; companyId?: string } = {},
) {
  const r = resolveAiPolicy(
    {
      companyId: over.companyId ?? COMPANY,
      version: over.version ?? 1,
      aiEnabled: over.aiEnabled ?? true,
      locality: 'LOCAL_ONLY',
      cloudEnabled: false,
      tasks: {
        'copilot.answer': {
          maxDataClass: 'CONFIDENTIAL',
          approvedModels: approved.map((modelId) => ({ modelId, p95LatencyMs: 1000 })),
          fallback: true,
        },
      },
    },
    over.companyId ?? COMPANY,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.policy;
}

const ctx = (over: Partial<AiCallContext> = {}): AiCallContext => ({
  task: 'copilot.answer',
  policy: policy(),
  dataClass: 'INTERNAL',
  companyId: COMPANY,
  userId: 'u',
  aiSessionId: 's',
  ...over,
});

function adapter(
  id: string,
  respond: (signal: AbortSignal) => Promise<NormalizedResponse>,
  locality: 'LOCAL' | 'CLOUD' = 'LOCAL',
  healthy = true,
): ProviderAdapter & { calls: number } {
  const a = {
    id,
    locality,
    calls: 0,
    listModels: () => Promise.resolve([]),
    health: () => Promise.resolve({ ok: healthy }),
    invoke: (_m: string, _r: unknown, signal: unknown) => {
      a.calls++;
      return respond(signal as AbortSignal);
    },
  };
  return a;
}

const answer = (text: string): NormalizedResponse => ({
  text,
  toolCalls: [],
  inputTokens: 12,
  outputTokens: 3,
});
const ask = {
  messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }],
};

function gateway(
  adapters: ProviderAdapter[],
  models: ModelInfo[],
  over: { timeoutMs?: number } = {},
) {
  return createAiGateway({ adapters, models, timeoutMs: over.timeoutMs ?? 1000 });
}

describe('AI gateway', () => {
  it('routes to the registered local model and reports who answered, with real usage', async () => {
    const a = adapter('local', () => Promise.resolve(answer('hello')));
    const r = await gateway([a], [model('local:m', 'local')]).generate(ctx(), ask);
    expect(r).toMatchObject({
      ok: true,
      value: { text: 'hello' },
      served: {
        modelId: 'local:m',
        locality: 'LOCAL',
        inputTokens: 12,
        costMicroInr: 0n,
        policyVersion: 1,
      },
    });
  });

  it('fails closed: no policy, AI switched off, task not enabled, or no model configured', async () => {
    const a = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway([a], [model('local:m', 'local')]);
    const blocked = { ok: false, reason: 'POLICY_BLOCKED' };
    expect(await g.generate(ctx({ policy: null }), ask)).toMatchObject(blocked);
    expect(
      await g.generate(ctx({ policy: policy(undefined, { aiEnabled: false }) }), ask),
    ).toMatchObject(blocked);
    const noTask = resolveAiPolicy(
      {
        companyId: COMPANY,
        version: 2,
        aiEnabled: true,
        locality: 'LOCAL_ONLY',
        cloudEnabled: false,
        tasks: {},
      },
      COMPANY,
    );
    expect(noTask.ok).toBe(true);
    if (noTask.ok)
      expect(await g.generate(ctx({ policy: noTask.policy }), ask)).toMatchObject(blocked);
    expect(await gateway([a], []).generate(ctx(), ask)).toMatchObject({ ok: false });
    expect(a.calls).toBe(0);
  });

  it('a blocked or failed call reports the version of a valid policy — never of an invalid or foreign one', async () => {
    const a = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway([a], [model('local:m', 'local')]);
    expect(
      await g.generate(ctx({ policy: policy(['local:m'], { version: 5, aiEnabled: false }) }), ask),
    ).toEqual({ ok: false, reason: 'POLICY_BLOCKED', policyVersion: 5 });
    expect(await g.generate(ctx({ policy: policy(['local:other'], { version: 6 }) }), ask)).toEqual(
      {
        ok: false,
        reason: 'POLICY_BLOCKED',
        policyVersion: 6,
      },
    );
    const foreign = policy(['local:m'], { version: 8, companyId: OTHER_COMPANY });
    expect(await g.generate(ctx({ policy: foreign }), ask)).toEqual({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    const tampered = {
      ...policy(['local:m'], { version: 99 }),
      cloudEnabled: true,
    } as unknown as ResolvedAiPolicy;
    expect(await g.generate(ctx({ policy: tampered }), ask)).toEqual({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    const down = adapter('d', () => Promise.resolve(answer('x')), 'LOCAL', false);
    expect(
      await gateway([down], [model('local:m', 'd')]).generate(
        ctx({ policy: policy(['local:m'], { version: 9 }) }),
        ask,
      ),
    ).toEqual({ ok: false, reason: 'AI_UNAVAILABLE', policyVersion: 9 });
    expect(a.calls).toBe(0);
  });

  it('uses the policy given with each call: a change applies to the very next call', async () => {
    const a = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway([a], [model('local:m', 'local')]);
    const first = await g.generate(ctx({ policy: policy(['local:m'], { version: 4 }) }), ask);
    expect(first).toMatchObject({ ok: true, served: { policyVersion: 4 } });
    const next = await g.generate(
      ctx({ policy: policy(['local:m'], { version: 5, aiEnabled: false }) }),
      ask,
    );
    expect(next).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED' });
    expect(a.calls).toBe(1);
  });

  it('never selects a configured model the policy has not approved', async () => {
    const a = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway([a], [model('local:m', 'local')]);
    expect(await g.generate(ctx({ policy: policy(['local:other']) }), ask)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    const two = adapter('two', () => Promise.resolve(answer('y')));
    const r = await gateway(
      [a, two],
      [model('local:m', 'local'), model('local:z', 'two')],
    ).generate(ctx({ policy: policy(['local:z']) }), ask);
    expect(r).toMatchObject({ ok: true, served: { modelId: 'local:z' } });
    expect(a.calls).toBe(0);
  });

  it('refuses a policy for another company, and an object whose content is not a valid policy', async () => {
    const a = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway([a], [model('local:m', 'local')]);
    const foreign = policy(['local:m'], { companyId: OTHER_COMPANY });
    expect(await g.generate(ctx({ policy: foreign }), ask)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    // Content is re-validated on every call: a tampered object is refused however it was built.
    const forged = { ...policy(['local:m']), cloudEnabled: true } as unknown as ResolvedAiPolicy;
    expect(await g.generate(ctx({ policy: forged }), ask)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    expect(a.calls).toBe(0);
  });

  it('never sends data above the policy, and never reaches a cloud model even if the policy lists it', async () => {
    const cloud = adapter('cloud', () => Promise.resolve(answer('cloud')), 'CLOUD');
    const local = adapter('local', () => Promise.resolve(answer('x')));
    const g = gateway(
      [cloud, local],
      [model('cloud:big', 'cloud', 'CLOUD'), model('local:m', 'local')],
    );
    expect(await g.generate(ctx({ dataClass: 'RESTRICTED' }), ask)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
    const ok = await g.generate(ctx(), ask);
    expect(ok.ok && ok.served.locality).toBe('LOCAL');
    expect(cloud.calls).toBe(0);
  });

  it('skips an unhealthy provider and reports unavailability without calling it', async () => {
    const down = adapter('local', () => Promise.resolve(answer('x')), 'LOCAL', false);
    expect(await gateway([down], [model('local:m', 'local')]).generate(ctx(), ask)).toMatchObject({
      ok: false,
      reason: 'AI_UNAVAILABLE',
    });
    expect(down.calls).toBe(0);
  });

  it('falls back only down the policy-approved list, recording what it replaced', async () => {
    const broken = adapter('a', () => Promise.reject(new ProviderError('MODEL_NOT_FOUND', 'gone')));
    const good = adapter('b', () => Promise.resolve(answer('ok')));
    const r = await gateway(
      [broken, good],
      [model('local:a', 'a'), model('local:b', 'b')],
    ).generate(ctx(), ask);
    expect(r).toMatchObject({ ok: true, served: { modelId: 'local:b', fallbackFrom: 'local:a' } });
  });

  it('times out with a typed failure and does not retry elsewhere', async () => {
    const slow = adapter(
      'a',
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const other = adapter('b', () => Promise.resolve(answer('late')));
    const r = await gateway([slow, other], [model('local:a', 'a'), model('local:b', 'b')], {
      timeoutMs: 20,
    }).generate(ctx(), ask);
    expect(r).toMatchObject({ ok: false, reason: 'TIMEOUT' });
    expect(other.calls).toBe(0);
  });

  describe('cancellation', () => {
    /** An adapter whose call only ends when its signal aborts; resolves `started` when called. */
    function hanging(id: string) {
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((r) => (markStarted = r));
      let listenerSeen = false;
      const a = adapter(
        id,
        (signal) =>
          new Promise((_, reject) => {
            listenerSeen = true;
            markStarted();
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      return { a, started, wasCalled: () => listenerSeen };
    }

    it('an already-cancelled request returns CANCELLED at once and never calls the provider', async () => {
      const controller = new AbortController();
      controller.abort();
      const { a } = hanging('a');
      const begun = Date.now();
      const r = await gateway([a], [model('local:a', 'a')], { timeoutMs: 5000 }).generate(
        ctx({ signal: controller.signal }),
        ask,
      );
      expect(r).toEqual({ ok: false, reason: 'CANCELLED' });
      expect(a.calls).toBe(0);
      expect(Date.now() - begun).toBeLessThan(1000);
    });

    it('cancelling during an active call aborts it, reports CANCELLED and tries no fallback', async () => {
      const controller = new AbortController();
      const { a, started } = hanging('a');
      const fallback = adapter('b', () => Promise.resolve(answer('should not be used')));
      const pending = gateway([a, fallback], [model('local:a', 'a'), model('local:b', 'b')], {
        timeoutMs: 5000,
      }).generate(ctx({ signal: controller.signal }), ask);
      await started;
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, reason: 'CANCELLED' });
      expect(a.calls).toBe(1);
      expect(fallback.calls).toBe(0);
    });

    it('cancellation is not reported as a provider failure even if the adapter throws its own error', async () => {
      const controller = new AbortController();
      const a = adapter('a', (signal) => {
        controller.abort();
        return signal.aborted
          ? Promise.reject(new ProviderError('UNAVAILABLE', 'socket closed'))
          : Promise.resolve(answer('x'));
      });
      expect(
        await gateway([a], [model('local:a', 'a')]).generate(
          ctx({ signal: controller.signal }),
          ask,
        ),
      ).toMatchObject({ ok: false, reason: 'CANCELLED' });
    });

    it('a structured request cancelled after an invalid answer makes no repair attempt', async () => {
      const controller = new AbortController();
      const a = adapter('a', () => {
        controller.abort(); // the user stops while the first (invalid) answer is coming back
        return Promise.resolve(answer('not json'));
      });
      const r = await gateway([a], [model('local:a', 'a')]).generateStructured(
        ctx({ signal: controller.signal }),
        { messages: ask.messages, schema: z.object({ total: z.number() }) },
      );
      expect(r).toMatchObject({ ok: false, reason: 'CANCELLED' });
      expect(a.calls).toBe(1);
    });

    it('an adapter that ignores the signal cannot turn a cancelled call into a success', async () => {
      const controller = new AbortController();
      let release: (r: NormalizedResponse) => void = () => undefined;
      const deaf = adapter(
        'a',
        () => new Promise<NormalizedResponse>((resolve) => (release = resolve)), // ignores abort
      );
      const pending = gateway([deaf], [model('local:a', 'a')], { timeoutMs: 5000 }).generate(
        ctx({ signal: controller.signal }),
        ask,
      );
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      release(answer('late answer')); // arrives after the user cancelled
      expect(await pending).toMatchObject({ ok: false, reason: 'CANCELLED' });
    });

    it('an adapter that ignores the signal still cannot outlive the timeout', async () => {
      const deaf = adapter('a', () => new Promise<NormalizedResponse>(() => undefined));
      const started = Date.now();
      const r = await gateway([deaf], [model('local:a', 'a')], { timeoutMs: 30 }).generate(
        ctx(),
        ask,
      );
      expect(r).toMatchObject({ ok: false, reason: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('an adapter that throws synchronously is a provider failure, not a crash', async () => {
      const throwing = adapter('a', () => {
        throw new ProviderError('MODEL_NOT_FOUND', 'gone');
      });
      const ok = adapter('b', () => Promise.resolve(answer('fallback')));
      const r = await gateway(
        [throwing, ok],
        [model('local:a', 'a'), model('local:b', 'b')],
      ).generate(ctx(), ask);
      expect(r).toMatchObject({
        ok: true,
        served: { modelId: 'local:b', fallbackFrom: 'local:a' },
      });
    });

    it('releases its listener on the caller signal, and a signal that never aborts changes nothing', async () => {
      const controller = new AbortController();
      let added = 0;
      let removed = 0;
      const signal = {
        get aborted() {
          return controller.signal.aborted;
        },
        addEventListener: (t: 'abort', l: () => void) => {
          added++;
          controller.signal.addEventListener(t, l);
        },
        removeEventListener: (t: 'abort', l: () => void) => {
          removed++;
          controller.signal.removeEventListener(t, l);
        },
      };
      const a = adapter('a', () => Promise.resolve(answer('fine')));
      const g = gateway([a], [model('local:a', 'a')]);
      const r1 = await g.generate(ctx({ signal }), ask);
      const r2 = await g.generate(ctx({ signal }), ask);
      expect(r1).toMatchObject({ ok: true, value: { text: 'fine' } });
      expect(r2.ok).toBe(true);
      expect(added).toBe(2);
      expect(removed).toBe(2);
    });
  });

  it('structured output is schema-validated, with one repair attempt', async () => {
    let n = 0;
    const a = adapter('a', () =>
      Promise.resolve(answer(n++ === 0 ? '{"total": "x"}' : '{"total": 3}')),
    );
    const r = await gateway([a], [model('local:a', 'a')]).generateStructured(ctx(), {
      messages: ask.messages,
      schema: z.object({ total: z.number() }),
    });
    expect(r).toMatchObject({ ok: true, value: { total: 3 } });
    const never = adapter('b', () => Promise.resolve(answer('not json')));
    expect(
      await gateway([never], [model('local:b', 'b')]).generateStructured(ctx(), {
        messages: ask.messages,
        schema: z.object({ total: z.number() }),
      }),
    ).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });
});

describe('Ollama adapter (mocked HTTP — no daemon needed)', () => {
  const models = [model('ollama:qwen2.5:7b', 'ollama')];
  const reply =
    (status: number, body: unknown): FetchLike =>
    () =>
      Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      });
  /** A runtime that lists the installed models and answers /api/chat with `chat`. */
  const runtime =
    (
      chat: FetchLike,
      installed: { name: string; remote_host?: string }[] = [{ name: 'qwen2.5:7b' }],
    ): FetchLike =>
    (url, init) =>
      url.endsWith('/api/tags') ? reply(200, { models: installed })(url, init) : chat(url, init);
  const req = { capability: 'chat' as const, messages: ask.messages };
  const signal = new AbortController().signal;

  it('maps text, tool calls and reported usage', async () => {
    const a = ollamaAdapter({
      baseUrl: 'http://x',
      models,
      fetch: runtime(
        reply(200, {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'stock_list', arguments: { q: 'MS' } } }],
          },
          prompt_eval_count: 40,
          eval_count: 7,
        }),
      ),
    });
    expect(await a.invoke('ollama:qwen2.5:7b', req, signal)).toEqual({
      text: '',
      toolCalls: [{ id: 'call_1', name: 'stock_list', arguments: { q: 'MS' } }],
      inputTokens: 40,
      outputTokens: 7,
    });
  });

  it('reports usage as unknown when the runtime does not send it', async () => {
    const a = ollamaAdapter({
      baseUrl: 'http://x',
      models,
      fetch: runtime(reply(200, { message: { role: 'assistant', content: 'hi' } })),
    });
    expect(await a.invoke('ollama:qwen2.5:7b', req, signal)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('turns failures into typed errors without echoing the prompt', async () => {
    const kind = async (f: FetchLike) =>
      ollamaAdapter({ baseUrl: 'http://x', models, fetch: runtime(f) })
        .invoke('ollama:qwen2.5:7b', req, signal)
        .then(
          () => null,
          (e: unknown) => (e instanceof ProviderError ? e.kind : 'other'),
        );
    expect(
      await ollamaAdapter({
        baseUrl: 'http://x',
        models,
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      })
        .invoke('ollama:qwen2.5:7b', req, signal)
        .catch((e: unknown) => (e instanceof ProviderError ? e.kind : 'other')),
    ).toBe('UNAVAILABLE');
    expect(await kind(() => Promise.reject(new TypeError('fetch failed')))).toBe('UNAVAILABLE');
    expect(await kind(reply(404, { error: "model 'qwen2.5:7b' not found" }))).toBe(
      'MODEL_NOT_FOUND',
    );
    expect(await kind(reply(200, 'not json'))).toBe('MALFORMED_RESPONSE');
    expect(await kind(reply(200, { unexpected: true }))).toBe('MALFORMED_RESPONSE');
    expect(await kind(reply(500, 'boom'))).toBe('UNAVAILABLE');
  });

  it('never sends a request to a model the runtime would forward to a remote host', async () => {
    const chats: string[] = [];
    const chat: FetchLike = (url) => {
      chats.push(url);
      return reply(200, { message: { role: 'assistant', content: 'hi' } })(url, { method: 'POST' });
    };
    for (const installed of [
      [{ name: 'qwen2.5:7b', remote_host: 'https://ollama.com:443' }],
      [{ name: 'gpt-oss:120b-cloud' }],
    ]) {
      const cloudModels = [model(`ollama:${installed[0]?.name ?? ''}`, 'ollama')];
      const a = ollamaAdapter({
        baseUrl: 'http://x',
        models: cloudModels,
        fetch: runtime(chat, installed),
      });
      await expect(a.invoke(cloudModels[0]?.id ?? '', req, signal)).rejects.toMatchObject({
        kind: 'NOT_SUPPORTED',
      });
      expect(await a.health()).toEqual({ ok: false, detail: 'MODEL_NOT_LOCAL' });
    }
    // A model that is not installed is never sent a chat either.
    const a = ollamaAdapter({ baseUrl: 'http://x', models, fetch: runtime(chat, []) });
    await expect(a.invoke('ollama:qwen2.5:7b', req, signal)).rejects.toMatchObject({
      kind: 'MODEL_NOT_FOUND',
    });
    expect(chats).toEqual([]);
  });

  it('health checks that the configured model is installed', async () => {
    const ok = ollamaAdapter({
      baseUrl: 'http://x',
      models,
      fetch: reply(200, { models: [{ name: 'qwen2.5:7b' }] }),
    });
    expect(await ok.health()).toEqual({ ok: true });
    const missing = ollamaAdapter({
      baseUrl: 'http://x',
      models,
      fetch: reply(200, { models: [] }),
    });
    expect(await missing.health()).toEqual({ ok: false, detail: 'MODEL_NOT_INSTALLED' });
    const down = ollamaAdapter({
      baseUrl: 'http://x',
      models,
      fetch: () => Promise.reject(new Error('x')),
    });
    expect(await down.health()).toEqual({ ok: false, detail: 'UNREACHABLE' });
    const odd = ollamaAdapter({ baseUrl: 'http://x', models, fetch: reply(200, { what: 1 }) });
    expect(await odd.health()).toEqual({ ok: false, detail: 'UNEXPECTED_RESPONSE' });
  });
});

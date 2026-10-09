import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { AI_DISABLED, type AiConfig } from '../config';
import { setAiPolicy } from '../modules/copilot';

/**
 * OPT-IN smoke test against a REAL local Ollama, through the real composition root. Skipped
 * unless FERP_OLLAMA_SMOKE_MODEL names a model that is ALREADY installed (nothing is pulled):
 *
 *   FERP_OLLAMA_SMOKE_MODEL=qwen2.5:7b npx vitest run --project integration ollama.smoke
 *
 * Synthetic fixture data only. Never contacts a cloud provider: a cloud-tagged model is
 * refused before any request (and checked here against the runtime's own model list).
 */
const MODEL = process.env.FERP_OLLAMA_SMOKE_MODEL ?? '';
const URL = process.env.FERP_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const config = (model: string): AiConfig => ({
  ...AI_DISABLED,
  provider: 'ollama',
  ollamaUrl: URL,
  model,
  timeoutMs: 90_000,
  healthTimeoutMs: 3_000,
});

describe.runIf(MODEL !== '')('real local Ollama (opt-in smoke test)', () => {
  let env: TestEnv;
  let F: Fixture;

  beforeAll(async () => {
    expect(MODEL).not.toMatch(/[:-]cloud$/i);
    env = await createTestEnv({ ai: { config: config(MODEL) } });
    F = await createFixture(env.services, { tag: 'smoke' });
    await env.services.commands.execute(
      setAiPolicy,
      {
        expectedVersion: 0,
        aiEnabled: true,
        tasks: {
          'copilot.answer': {
            maxDataClass: 'CONFIDENTIAL',
            approvedModels: [{ modelId: `ollama:${MODEL}`, p95LatencyMs: 90_000 }],
            fallback: false,
          },
        },
        reason: 'Smoke test of the local model',
      },
      F.actors.owner,
    );
  });
  afterAll(async () => env?.destroy());

  it('the runtime is reachable and the model is installed and local', async () => {
    expect(await env.services.ai.check()).toMatchObject({
      state: 'REACHABLE',
      locality: 'LOCAL',
      modelId: `ollama:${MODEL}`,
    });
  });

  it('answers a question through the copilot, within the turn bound', async () => {
    const t0 = Date.now();
    const r = await env.services.copilot.answer(F.actors.owner, {
      question: 'Which warehouses do we have? Look it up with your tools.',
    });
    const ms = Date.now() - t0;
    // A summary for the person running the smoke test (synthetic data only).
    process.stdout.write(
      `${JSON.stringify({
        ok: r.ok,
        reason: r.ok ? null : r.reason,
        modelCalls: r.modelCalls,
        toolCalls: r.toolCalls,
        ms,
        answer: r.ok ? r.answer.slice(0, 300) : null,
      })}\n`,
    );
    expect(r).toMatchObject({
      ok: true,
      servedBy: { providerId: 'ollama', modelId: `ollama:${MODEL}`, locality: 'LOCAL' },
    });
    expect(ms).toBeLessThan(env.services.copilot.limits.turnTimeoutMs);
  }, 200_000);

  it('a cloud model listed by the runtime is refused before any chat request', async () => {
    const tags = (await (await fetch(`${URL}/api/tags`)).json()) as {
      models: { name: string; remote_host?: string }[];
    };
    const cloud = tags.models.find((m) => m.remote_host !== undefined);
    if (!cloud) return; // nothing to check on this machine
    const cloudEnv = await createTestEnv({ ai: { config: config(cloud.name) } });
    try {
      const status = await cloudEnv.services.ai.check();
      expect(status).toMatchObject({ state: 'UNAVAILABLE', reason: 'MODEL_NOT_LOCAL' });
    } finally {
      await cloudEnv.destroy();
    }
  });
});

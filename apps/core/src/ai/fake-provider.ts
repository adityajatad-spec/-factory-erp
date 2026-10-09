import { ProviderError, type ModelInfo, type ProviderAdapter } from '@factory-erp/ai';

/**
 * A deterministic stand-in for a local model, for automated tests and development without a
 * model installed (AI_PROVIDER=fake; refused in production). It needs no network, no keys and
 * no downloads. It is not a model: it echoes, so nothing measured with it says anything about
 * real-model quality. Usage is reported as unknown, like a runtime that does not count tokens.
 */

export const FAKE_MODEL_ID = 'fake:deterministic';

export type FakeBehaviour = 'echo' | 'unavailable' | 'hang';

export const fakeModel: ModelInfo = {
  id: FAKE_MODEL_ID,
  providerId: 'fake',
  locality: 'LOCAL',
  capabilities: ['chat', 'tools', 'structured'],
  contextTokens: 32_000,
  priceInPerMTokMicroInr: 0n,
  priceOutPerMTokMicroInr: 0n,
};

export function fakeProvider(behaviour: FakeBehaviour = 'echo'): ProviderAdapter {
  return {
    id: 'fake',
    locality: 'LOCAL',
    listModels: () => Promise.resolve([fakeModel]),
    health: () =>
      Promise.resolve(
        behaviour === 'unavailable' ? { ok: false, detail: 'UNREACHABLE' } : { ok: true },
      ),
    invoke(_model, req, signal) {
      if (behaviour === 'unavailable') {
        return Promise.reject(new ProviderError('UNAVAILABLE', 'fake provider is down'));
      }
      if (behaviour === 'hang') {
        // Never answers; ends only when the gateway aborts (timeout or cancellation).
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(new ProviderError('CANCELLED', 'fake call aborted')),
          ),
        );
      }
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = lastUser?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      return Promise.resolve({
        text: req.outputSchema ? JSON.stringify({ echo: text }) : `Fake reply: ${text}`,
        toolCalls: [],
        inputTokens: null,
        outputTokens: null,
      });
    },
  };
}

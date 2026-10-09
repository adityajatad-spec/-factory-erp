import {
  type Locality,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderHealthDetail,
} from '@factory-erp/ai';
import { fakeModel, fakeProvider, type FakeBehaviour } from './fake-provider';
import { createAiGateway, type ObservedGateway } from './gateway';
import { ollamaAdapter, type FetchLike } from './ollama';

/**
 * The AI subsystem as the server sees it: a gateway built from operational settings, and an
 * honest status. Constructing it makes no network call, so the ERP starts whether or not a
 * local model runtime is running; availability is checked only when asked, within a bound.
 */

/** Operational settings (mapped from the validated environment by the composition root). */
export interface AiSettings {
  provider: 'none' | 'ollama' | 'fake';
  ollamaUrl: string;
  model: string | null;
  contextTokens: number;
  timeoutMs: number;
  healthTimeoutMs: number;
}

export type AiState = 'DISABLED' | 'NOT_CHECKED' | 'REACHABLE' | 'UNAVAILABLE';

export interface AiStatus {
  state: AiState;
  providerId: string | null;
  modelId: string | null;
  locality: Locality | null;
  /** Why it is unavailable (a code — never a URL or an error message). */
  reason: ProviderHealthDetail | null;
  checkedAt: string | null;
  /**
   * The signed-in company's AI policy. The service itself never resolves one (NOT_RESOLVED);
   * the status route fills it in from the stored, validated policy.
   */
  policy: AiPolicyStatus;
}

export interface AiPolicyStatus {
  state: 'NOT_RESOLVED' | 'NONE' | 'INVALID' | 'UNAVAILABLE' | 'DISABLED' | 'ENABLED';
  /** Only for a policy that validated for this company. */
  version: number | null;
}

export interface AiService {
  readonly enabled: boolean;
  /** Null when AI is disabled. */
  readonly gateway: ObservedGateway | null;
  /** The last known status, without any check. */
  peek(): AiStatus;
  /** Check availability now (bounded by the health timeout) and return the result. */
  check(): Promise<AiStatus>;
}

export interface AiServiceOptions {
  /** HTTP client for the local runtime (tests inject one; no network in CI). */
  fetch?: FetchLike;
  fakeBehaviour?: FakeBehaviour;
  now?: () => Date;
}

export function createAiService(settings: AiSettings, opts: AiServiceOptions = {}): AiService {
  const now = opts.now ?? (() => new Date());
  // There is no policy source here on purpose: each model call carries the company's resolved
  // policy (AiCallContext.policy). Settings only describe what is installed.
  const statusOf = (s: Omit<AiStatus, 'policy'>): AiStatus => ({
    ...s,
    policy: { state: 'NOT_RESOLVED', version: null },
  });

  if (settings.provider === 'none') {
    const disabled = () =>
      statusOf({
        state: 'DISABLED',
        providerId: null,
        modelId: null,
        locality: null,
        reason: null,
        checkedAt: null,
      });
    return {
      enabled: false,
      gateway: null,
      peek: disabled,
      check: () => Promise.resolve(disabled()),
    };
  }

  let model: ModelInfo;
  let adapter: ProviderAdapter;
  if (settings.provider === 'fake') {
    model = fakeModel;
    adapter = fakeProvider(opts.fakeBehaviour);
  } else {
    if (!settings.model) throw new Error('AI model is not configured'); // config validation prevents this
    model = {
      id: `ollama:${settings.model}`,
      providerId: 'ollama',
      locality: 'LOCAL',
      capabilities: ['chat', 'tools', 'structured'],
      contextTokens: settings.contextTokens,
      priceInPerMTokMicroInr: 0n,
      priceOutPerMTokMicroInr: 0n,
    };
    adapter = ollamaAdapter({
      baseUrl: settings.ollamaUrl,
      models: [model],
      healthTimeoutMs: settings.healthTimeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  const gateway = createAiGateway({
    adapters: [adapter],
    models: [model],
    timeoutMs: settings.timeoutMs,
  });

  let last: AiStatus = statusOf({
    state: 'NOT_CHECKED',
    providerId: adapter.id,
    modelId: model.id,
    locality: adapter.locality,
    reason: null,
    checkedAt: null,
  });

  return {
    enabled: true,
    gateway,
    peek: () => last,
    async check() {
      // The adapter bounds its own check; this outer bound guards against a misbehaving one.
      const bound = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), settings.healthTimeoutMs + 500).unref(),
      );
      const statuses = await Promise.race([gateway.status(), bound]);
      const mine = statuses?.find((s) => s.providerId === adapter.id);
      const healthy = !!mine?.healthy && !mine.circuitOpen;
      last = statusOf({
        state: healthy ? 'REACHABLE' : 'UNAVAILABLE',
        providerId: adapter.id,
        modelId: model.id,
        locality: adapter.locality,
        reason: healthy ? null : (mine?.detail ?? 'UNREACHABLE'),
        checkedAt: now().toISOString(),
      });
      return last;
    },
  };
}

import type { DataClass } from '@factory-erp/contracts';

/** What a model can do. A request names the capabilities it needs. */
export const CAPABILITIES = ['chat', 'tools', 'structured', 'vision', 'embed'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Where inference runs. LOCAL never leaves the factory node. */
export type Locality = 'LOCAL' | 'CLOUD';

/** What a call is for. Policy, qualification and cost are all decided per task. */
export const TASKS = [
  'copilot.answer',
  'copilot.plan',
  'doc.classify',
  'doc.extract',
  'doc.extract.handwritten',
  'text.summarize',
  'search.embed',
] as const;
export type Task = (typeof TASKS)[number];

/** A model the gateway may use, as registered by an administrator (data, not code). */
export interface ModelInfo {
  /** Opaque, stable identifier, e.g. "local:small-instruct". */
  id: string;
  providerId: string;
  locality: Locality;
  capabilities: readonly Capability[];
  /** Input + output tokens the model can handle in one call. */
  contextTokens: number;
  /**
   * Prices per million tokens in micro-rupees, from the effective-dated price book (never
   * hard-coded — provider prices change). Zero for local models.
   */
  priceInPerMTokMicroInr: bigint;
  priceOutPerMTokMicroInr: bigint;
}

/** Live availability of a provider (runtime up, credentials valid, circuit breaker state). */
export interface ProviderStatus {
  providerId: string;
  healthy: boolean;
  circuitOpen: boolean;
  /** Why it is unhealthy, as a short code — never a URL, credential or message text. */
  detail?: ProviderHealthDetail;
}

export type ProviderHealthDetail =
  | 'UNREACHABLE'
  | 'MODEL_NOT_INSTALLED'
  | 'UNEXPECTED_RESPONSE'
  /** The runtime would forward the model to a remote host (e.g. an Ollama "-cloud" model). */
  | 'MODEL_NOT_LOCAL';

/**
 * A model passed a task's evaluation set on THIS hardware (ARCHITECTURE Round 2 §9.4).
 * Unqualified models are never used: a slow, wrong answer is worse than none.
 */
export interface Qualification {
  modelId: string;
  task: Task;
  /** Measured 95th-percentile latency for the task. */
  p95LatencyMs: number;
}

/** How one task may use AI. A task without a policy has AI switched off. */
export interface TaskPolicy {
  /** Most sensitive data a LOCAL model may see for this task. */
  maxLocalDataClass: DataClass;
  /** Most sensitive data a CLOUD model may see; null keeps this task off the cloud. */
  maxCloudDataClass: DataClass | null;
  /**
   * An explicit OWNER exception: RESTRICTED content may go to the cloud for this task (for
   * example a scanned bill that shows bank details, which cannot be redacted). Requires
   * `maxCloudDataClass: 'RESTRICTED'` as well. Credentials are removed before any prompt.
   */
  allowRestrictedToCloud?: boolean;
  preference: 'LOCAL_FIRST' | 'CLOUD_FIRST';
  /** Use only this model (it must still pass every other check). */
  pinnedModelId?: string;
  /** Offer further eligible models as fallbacks if the first fails. */
  fallback: boolean;
}

/**
 * The owner's AI policy: stored as data, versioned, and changed only by FORBIDDEN-tier owner
 * commands — the AI can never change its own policy.
 */
export interface AiPolicy {
  version: number;
  /** LOCAL: never the cloud. CLOUD: prefer the cloud. HYBRID: per-task preference. */
  mode: 'LOCAL' | 'CLOUD' | 'HYBRID';
  /** Master switch for any cloud inference. Default: off. */
  cloudEnabled: boolean;
  tasks: Partial<Record<Task, TaskPolicy>>;
  monthlyCloudBudgetMicroInr: bigint;
}

/** The safe default: local only, cloud off, AI off for tasks nobody has enabled. */
export const DEFAULT_POLICY: AiPolicy = {
  version: 0,
  mode: 'LOCAL',
  cloudEnabled: false,
  tasks: {},
  monthlyCloudBudgetMicroInr: 0n,
};

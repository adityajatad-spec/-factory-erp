import type { DataClass } from '@factory-erp/contracts';
import type { z } from 'zod';
import type { ResolvedAiPolicy } from './policy';
import type { Capability, Locality, ModelInfo, ProviderHealthDetail, Task } from './types';

/**
 * The interfaces business code will depend on (docs/ROADMAP.md §5.3). Nothing here names a
 * provider: adapters (local runtimes, cloud APIs) translate these neutral types into their own
 * wire formats, so a provider can be swapped or added without touching the copilot.
 */

/** What cancellation needs (a standard AbortSignal fits); keeps this package free of runtime types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  /** So callers can detach their listener when a call ends (no leaks across long sessions). */
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AiCallContext {
  task: Task;
  /**
   * The company's policy, resolved by the server for THIS call (see policy.ts). Required: the
   * gateway has no policy of its own, and anything not produced by `resolveAiPolicy` — or for
   * another company — means AI off. The model never sees or edits it.
   */
  policy: ResolvedAiPolicy | null;
  /** High-water mark of everything in the request (sticky for the whole session). */
  dataClass: DataClass;
  companyId: string;
  userId: string;
  aiSessionId: string;
  budget?: { maxCostMicroInr?: bigint; maxLatencyMs?: number; maxOutputTokens?: number };
  signal?: AbortSignalLike;
}

export type MessagePart =
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: Uint8Array };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: readonly MessagePart[];
  /** For role "tool": which tool call this answers. */
  toolCallId?: string;
  /** For role "tool": the tool's name (some runtimes match results by name). */
  toolName?: string;
  /** For role "assistant": the tool calls it made (so the model sees its own history). */
  toolCalls?: readonly ToolCall[];
}

/** A tool offered to the model; its parameters are JSON Schema generated from a Zod input. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface GenerateRequest {
  messages: readonly Message[];
  tools?: readonly ToolSpec[];
  maxOutputTokens?: number;
}

export interface GenerateOutput {
  text: string;
  toolCalls: readonly ToolCall[];
}

export interface StructuredRequest<T> {
  messages: readonly Message[];
  /** The output is validated against this schema; one repair attempt, then a typed failure. */
  schema: z.ZodType<T>;
}

export interface EmbedRequest {
  texts: readonly string[];
}

export interface VisionRequest<T> {
  /** Page images and the instruction; extraction steps get no tools (prompt-injection guard). */
  messages: readonly Message[];
  schema: z.ZodType<T>;
}

/** Who answered — shown in the UI ("local" or "cloud") and recorded for audit and cost. */
export interface ServedBy {
  providerId: string;
  modelId: string;
  locality: Locality;
  /** As reported by the runtime; null when it does not report them. Never estimated. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Zero for local inference; null when a provider's cost is not known reliably. */
  costMicroInr: bigint | null;
  latencyMs: number;
  policyVersion: number;
  /** The candidate this replaced, if the first choice failed. */
  fallbackFrom?: string;
}

export type AiFailure =
  | 'AI_UNAVAILABLE'
  | 'POLICY_BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'SCHEMA_INVALID'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'MODEL_NOT_FOUND'
  | 'MALFORMED_RESPONSE'
  | 'NOT_SUPPORTED';

/** AI never throws into business code: it answers, or it says why not (and the UI falls back). */
export type AiResult<T> =
  | { ok: true; value: T; served: ServedBy }
  | {
      ok: false;
      reason: AiFailure;
      served?: ServedBy;
      /**
       * The version of the company policy the request was judged under — only when that policy
       * re-validated for the calling company (never taken from an invalid or foreign policy).
       */
      policyVersion?: number;
    };

export interface AiGateway {
  generate(ctx: AiCallContext, req: GenerateRequest): Promise<AiResult<GenerateOutput>>;
  generateStructured<T>(ctx: AiCallContext, req: StructuredRequest<T>): Promise<AiResult<T>>;
  embed(ctx: AiCallContext, req: EmbedRequest): Promise<AiResult<number[][]>>;
  vision<T>(ctx: AiCallContext, req: VisionRequest<T>): Promise<AiResult<T>>;
}

/** Provider-neutral request an adapter receives (the gateway has already routed it). */
export interface NormalizedRequest {
  capability: Capability;
  messages: readonly Message[];
  tools?: readonly ToolSpec[];
  /** JSON Schema for structured output, when requested. */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface NormalizedResponse {
  text: string;
  toolCalls: readonly ToolCall[];
  embeddings?: number[][];
  /** Null when the runtime does not report usage. Adapters never estimate. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ProviderErrorKind =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'MODEL_NOT_FOUND'
  | 'MALFORMED_RESPONSE'
  | 'NOT_SUPPORTED';

/** What adapters throw. Messages never contain prompt text. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

/** One per runtime or cloud provider. Only adapters may import SDKs or make network calls. */
export interface ProviderAdapter {
  readonly id: string;
  readonly locality: Locality;
  listModels(): Promise<ModelInfo[]>;
  /** Bounded availability check; `detail` is a code, never a URL or message text. */
  health(): Promise<{ ok: boolean; detail?: ProviderHealthDetail }>;
  invoke(
    model: string,
    req: NormalizedRequest,
    signal: AbortSignalLike,
  ): Promise<NormalizedResponse>;
}

import type { DataClass } from '@factory-erp/contracts';
import type { z } from 'zod';
import type { Capability, Locality, ModelInfo, Task } from './types';

/**
 * The interfaces business code will depend on (docs/ROADMAP.md §5.3). Nothing here names a
 * provider: adapters (local runtimes, cloud APIs) translate these neutral types into their own
 * wire formats, so a provider can be swapped or added without touching the copilot.
 */

/** What cancellation needs (a standard AbortSignal fits); keeps this package free of runtime types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

export interface AiCallContext {
  task: Task;
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
  inputTokens: number;
  outputTokens: number;
  costMicroInr: bigint;
  latencyMs: number;
  /** The candidate this replaced, if the first choice failed. */
  fallbackFrom?: string;
}

export type AiFailure =
  'AI_UNAVAILABLE' | 'POLICY_BLOCKED' | 'BUDGET_EXCEEDED' | 'SCHEMA_INVALID' | 'TIMEOUT';

/** AI never throws into business code: it answers, or it says why not (and the UI falls back). */
export type AiResult<T> =
  { ok: true; value: T; served: ServedBy } | { ok: false; reason: AiFailure; served?: ServedBy };

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
  inputTokens: number;
  outputTokens: number;
}

/** One per runtime or cloud provider. Only adapters may import SDKs or make network calls. */
export interface ProviderAdapter {
  readonly id: string;
  readonly locality: Locality;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  invoke(
    model: string,
    req: NormalizedRequest,
    signal: AbortSignalLike,
  ): Promise<NormalizedResponse>;
}

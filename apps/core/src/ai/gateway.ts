import {
  ProviderError,
  route,
  routingInputsFor,
  taskRules,
  validPolicyFor,
  type AbortSignalLike,
  type AiCallContext,
  type AiFailure,
  type AiGateway,
  type AiResult,
  type Capability,
  type GenerateOutput,
  type GenerateRequest,
  type ModelInfo,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderHealthDetail,
  type ProviderStatus,
  type RouteDecision,
  type ServedBy,
  type StructuredRequest,
} from '@factory-erp/ai';
import { z } from 'zod';

/**
 * The AI gateway (docs/ARCHITECTURE.md G.1): route with the pure policy, call the chosen
 * adapter with a hard timeout, fall back only down the router's own candidate list, and
 * report who answered. It knows nothing about invoices or suppliers — business data reaches
 * it only as messages and tool specs built by the copilot.
 *
 * It holds no policy. Every call carries the company's policy (`ctx.policy`), re-validated here
 * by content against the calling company on each call. A model is used only if it is both
 * configured here (installed locally) and approved by that policy for the task —
 * configuration alone never authorises a model.
 *
 * Callers (the B2 runtime) must resolve the company's CURRENT stored policy for every call and
 * take `companyId`, the user and `dataClass` from the server side (session, and the classes of
 * the tools whose results are included) — never from the model. Then a revocation applies to
 * the very next call. The gateway cannot see where a policy came from, only whether it is valid.
 */

export interface GatewayConfig {
  adapters: readonly ProviderAdapter[];
  /** Models installed and configured locally. Necessary, never sufficient: see the policy. */
  models: readonly ModelInfo[];
  timeoutMs: number;
  /** How long a provider health result is trusted (ms). */
  healthTtlMs?: number;
  now?: () => number;
}

export interface GatewayDecision {
  decision: RouteDecision;
  /** Final outcome of the call (for the usage record). */
  failure?: AiFailure;
}

export interface ObservedGateway extends AiGateway {
  /** Health of every registered provider (cached briefly). */
  status(): Promise<ProviderStatus[]>;
  /** The routing decision a request would get right now (no model call). */
  plan(ctx: AiCallContext, capabilities: readonly Capability[]): Promise<RouteDecision>;
}

const FAILURE_OF: Record<ProviderError['kind'], AiFailure> = {
  UNAVAILABLE: 'AI_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
};

/** Rough size of a request, for context-window and cost checks (characters / 4, rounded up). */
export function estimateTokens(req: { messages: NormalizedRequest['messages']; tools?: unknown }) {
  let chars = 0;
  for (const m of req.messages)
    for (const p of m.parts) if (p.type === 'text') chars += p.text.length;
  chars += req.tools ? JSON.stringify(req.tools).length : 0;
  return Math.ceil(chars / 4);
}

export function createAiGateway(cfg: GatewayConfig): ObservedGateway {
  const now = cfg.now ?? (() => Date.now());
  const ttl = cfg.healthTtlMs ?? 10_000;
  let cached: { at: number; statuses: ProviderStatus[] } | null = null;

  async function status(): Promise<ProviderStatus[]> {
    if (cached && now() - cached.at < ttl) return cached.statuses;
    const statuses = await Promise.all(
      cfg.adapters.map(async (a) => {
        const h = await a.health().catch((): { ok: boolean; detail?: ProviderHealthDetail } => ({
          ok: false,
          detail: 'UNREACHABLE',
        }));
        const status: ProviderStatus = { providerId: a.id, healthy: h.ok, circuitOpen: false };
        if (!h.ok && h.detail) status.detail = h.detail;
        return status;
      }),
    );
    cached = { at: now(), statuses };
    return statuses;
  }

  async function plan(
    ctx: AiCallContext,
    capabilities: readonly Capability[],
    tokens = 0,
  ): Promise<RouteDecision> {
    // Missing, forged, disabled, other-company or task-not-enabled policy: AI off. No provider
    // is contacted, not even for a health check.
    const rules = taskRules(ctx.policy, ctx.companyId, ctx.task);
    if (!rules) {
      // Report the version only of a policy that re-validates for this company (0 = none).
      const version = validPolicyFor(ctx.policy, ctx.companyId)?.version ?? 0;
      return { ok: false, reason: 'POLICY_BLOCKED', excluded: [], policyVersion: version };
    }
    const { policy, qualifications } = routingInputsFor(ctx.task, rules);
    const approved = new Set(rules.approvedModels.map((m) => m.modelId));
    const models = cfg.models.filter((m) => m.locality === 'LOCAL' && approved.has(m.id));
    return route(
      {
        task: ctx.task,
        dataClass: ctx.dataClass,
        capabilities,
        estimatedInputTokens: tokens,
        estimatedOutputTokens: ctx.budget?.maxOutputTokens ?? 1024,
        ...(ctx.budget?.maxCostMicroInr !== undefined
          ? { maxCostMicroInr: ctx.budget.maxCostMicroInr }
          : {}),
      },
      policy,
      {
        models,
        providers: models.length ? await status() : [],
        qualifications,
        cloudSpentThisMonthMicroInr: 0n,
      },
    );
  }

  /**
   * Call one adapter with a hard timeout that also honours the caller's cancellation. A request
   * cancelled before the call never reaches the provider. The adapter's answer races the abort,
   * so cancellation and the timeout win even against an adapter that ignores its signal (a late
   * answer is discarded, never reported as success). Timer and listeners are always released.
   */
  async function invoke(
    adapter: ProviderAdapter,
    modelId: string,
    req: NormalizedRequest,
    callerSignal: AbortSignalLike | undefined,
  ): Promise<NormalizedResponse> {
    if (callerSignal?.aborted) throw new ProviderError('CANCELLED', 'Cancelled by the user');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, cfg.timeoutMs);
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError('CANCELLED', 'Aborted'));
      controller.signal.addEventListener('abort', onAbort);
    });
    // A synchronous throw from the adapter becomes a rejection, so cleanup below still runs.
    const answer = new Promise<NormalizedResponse>((resolve, reject) => {
      try {
        resolve(adapter.invoke(modelId, req, controller.signal));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('adapter failed'));
      }
    });
    // Whichever promise loses the race must not surface as an unhandled rejection.
    answer.catch(() => undefined);
    aborted.catch(() => undefined);
    try {
      return await Promise.race([answer, aborted]);
    } catch (e) {
      // The caller's cancellation wins over whatever the adapter reports for the aborted call.
      if (callerSignal?.aborted) throw new ProviderError('CANCELLED', 'Cancelled by the user');
      if (timedOut) throw new ProviderError('TIMEOUT', `No answer within ${cfg.timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function run(
    ctx: AiCallContext,
    req: NormalizedRequest,
  ): Promise<AiResult<NormalizedResponse>> {
    // Already cancelled: no routing, no provider call.
    if (ctx.signal?.aborted) return { ok: false, reason: 'CANCELLED' };
    const capabilities: Capability[] = [req.capability];
    if (req.tools?.length) capabilities.push('tools');
    const decision = await plan(ctx, capabilities, estimateTokens(req));
    const versioned = decision.policyVersion > 0 ? { policyVersion: decision.policyVersion } : {};
    if (ctx.signal?.aborted) return { ok: false, reason: 'CANCELLED', ...versioned };
    if (!decision.ok) return { ok: false, reason: decision.reason, ...versioned };
    let lastFailure: AiFailure = 'AI_UNAVAILABLE';
    let previous: string | undefined;
    for (const c of decision.candidates) {
      const adapter = cfg.adapters.find((a) => a.id === c.providerId);
      // The router only returns registered, healthy providers; be defensive anyway.
      if (!adapter || adapter.locality !== c.locality) continue;
      const started = now();
      const served = (r: NormalizedResponse | null): ServedBy => ({
        providerId: c.providerId,
        modelId: c.modelId,
        locality: c.locality,
        inputTokens: r?.inputTokens ?? null,
        outputTokens: r?.outputTokens ?? null,
        // Local inference has no per-call price; cloud cost would come from the price book.
        costMicroInr: c.locality === 'LOCAL' ? 0n : null,
        latencyMs: now() - started,
        policyVersion: decision.policyVersion,
        ...(previous ? { fallbackFrom: previous } : {}),
      });
      if (ctx.signal?.aborted) return { ok: false, reason: 'CANCELLED', ...versioned };
      try {
        const r = await invoke(adapter, c.modelId, req, ctx.signal);
        return { ok: true, value: r, served: served(r) };
      } catch (e) {
        lastFailure = e instanceof ProviderError ? FAILURE_OF[e.kind] : 'AI_UNAVAILABLE';
        if (e instanceof ProviderError && e.kind === 'UNAVAILABLE') cached = null;
        // Cancellation and timeouts are the caller's limits: never retry them elsewhere.
        if (lastFailure === 'CANCELLED' || lastFailure === 'TIMEOUT') {
          return { ok: false, reason: lastFailure, served: served(null), ...versioned };
        }
        previous = c.modelId;
      }
    }
    return { ok: false, reason: lastFailure, ...versioned };
  }

  return {
    status,
    plan: (ctx, capabilities) => plan(ctx, capabilities),

    async generate(ctx: AiCallContext, req: GenerateRequest): Promise<AiResult<GenerateOutput>> {
      const r = await run(ctx, {
        capability: 'chat',
        messages: req.messages,
        ...(req.tools?.length ? { tools: req.tools } : {}),
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      });
      if (!r.ok) return r;
      return {
        ok: true,
        value: { text: r.value.text, toolCalls: r.value.toolCalls },
        served: r.served,
      };
    },

    async generateStructured<T>(
      ctx: AiCallContext,
      req: StructuredRequest<T>,
    ): Promise<AiResult<T>> {
      const outputSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
      let messages = req.messages;
      // One repair attempt with the validation problems, then a typed failure.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await run(ctx, { capability: 'structured', messages, outputSchema });
        if (!r.ok) return r;
        let json: unknown;
        try {
          json = JSON.parse(r.value.text);
        } catch {
          json = undefined;
        }
        const parsed = req.schema.safeParse(json);
        if (parsed.success) return { ok: true, value: parsed.data, served: r.served };
        if (attempt === 1) return { ok: false, reason: 'SCHEMA_INVALID', served: r.served };
        // A repair is a new model call: never make it for a cancelled request.
        if (ctx.signal?.aborted) return { ok: false, reason: 'CANCELLED', served: r.served };
        messages = [
          ...messages,
          { role: 'assistant', parts: [{ type: 'text', text: r.value.text }] },
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text: 'That was not valid for the required JSON schema. Reply with JSON only, matching the schema exactly.',
              },
            ],
          },
        ];
      }
      return { ok: false, reason: 'SCHEMA_INVALID' };
    },

    embed: () => Promise.resolve({ ok: false, reason: 'NOT_SUPPORTED' }),
    vision: () => Promise.resolve({ ok: false, reason: 'NOT_SUPPORTED' }),
  };
}

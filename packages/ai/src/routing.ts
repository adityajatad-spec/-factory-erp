import { withinDataClass, type DataClass } from '@factory-erp/contracts';
import type {
  AiPolicy,
  Capability,
  Locality,
  ModelInfo,
  ProviderStatus,
  Qualification,
  Task,
  TaskPolicy,
} from './types';

/**
 * Which models may serve a request, in order (docs/ROADMAP.md §5.4). Pure and deterministic:
 * no I/O, no clock, no randomness, and the order of the inputs does not matter. It never calls
 * a provider — the gateway calls the first candidate and falls back down this same list, so a
 * fallback can never reach a model the policy excluded.
 */

export interface RouteRequest {
  task: Task;
  /** High-water mark of everything the call would send. */
  dataClass: DataClass;
  capabilities: readonly Capability[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  maxCostMicroInr?: bigint;
  maxLatencyMs?: number;
}

export interface RouteState {
  models: readonly ModelInfo[];
  providers: readonly ProviderStatus[];
  qualifications: readonly Qualification[];
  cloudSpentThisMonthMicroInr: bigint;
}

export type ExclusionReason =
  | 'NO_TASK_POLICY'
  | 'MODE_LOCAL'
  | 'CLOUD_DISABLED'
  | 'DATA_CLASS'
  | 'NOT_PINNED'
  | 'CAPABILITY'
  | 'CONTEXT_TOO_SMALL'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_QUALIFIED'
  | 'COST'
  | 'MONTHLY_BUDGET'
  | 'LATENCY';

/** Exclusions the owner's policy causes (as opposed to availability or money). */
const POLICY_REASONS: ReadonlySet<ExclusionReason> = new Set([
  'NO_TASK_POLICY',
  'MODE_LOCAL',
  'CLOUD_DISABLED',
  'DATA_CLASS',
  'NOT_PINNED',
]);

export interface Candidate {
  modelId: string;
  providerId: string;
  locality: Locality;
  estimatedCostMicroInr: bigint;
  p95LatencyMs: number;
}

export interface Exclusion {
  modelId: string;
  reason: ExclusionReason;
}

export type RouteDecision =
  | {
      ok: true;
      candidates: readonly Candidate[];
      excluded: readonly Exclusion[];
      policyVersion: number;
    }
  | {
      ok: false;
      reason: 'AI_UNAVAILABLE' | 'POLICY_BLOCKED' | 'BUDGET_EXCEEDED';
      excluded: readonly Exclusion[];
      policyVersion: number;
    };

const MILLION = 1_000_000n;

/** Estimated cost in micro-rupees, rounded up (integer arithmetic only — this is money). */
export function estimateCostMicroInr(model: ModelInfo, inputTokens: number, outputTokens: number) {
  const total =
    BigInt(inputTokens) * model.priceInPerMTokMicroInr +
    BigInt(outputTokens) * model.priceOutPerMTokMicroInr;
  return (total + MILLION - 1n) / MILLION;
}

/** May data of class `dataClass` go to a model of this locality for this task? */
export function localityAllowed(
  policy: AiPolicy,
  task: TaskPolicy,
  locality: Locality,
  dataClass: DataClass,
): ExclusionReason | null {
  if (locality === 'LOCAL') {
    return withinDataClass(dataClass, task.maxLocalDataClass) ? null : 'DATA_CLASS';
  }
  if (policy.mode === 'LOCAL') return 'MODE_LOCAL';
  if (!policy.cloudEnabled || task.maxCloudDataClass === null) return 'CLOUD_DISABLED';
  if (dataClass === 'RESTRICTED') {
    // RESTRICTED needs two explicit decisions, never one by accident.
    return task.allowRestrictedToCloud === true && task.maxCloudDataClass === 'RESTRICTED'
      ? null
      : 'DATA_CLASS';
  }
  return withinDataClass(dataClass, task.maxCloudDataClass) ? null : 'DATA_CLASS';
}

export function route(req: RouteRequest, policy: AiPolicy, state: RouteState): RouteDecision {
  const policyVersion = policy.version;
  const models = [...state.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const task = policy.tasks[req.task];
  if (!task) {
    return {
      ok: false,
      reason: 'POLICY_BLOCKED',
      excluded: models.map((m) => ({ modelId: m.id, reason: 'NO_TASK_POLICY' })),
      policyVersion,
    };
  }

  const providerOk = (id: string) =>
    state.providers.some((p) => p.providerId === id && p.healthy && !p.circuitOpen);
  // A model may have several qualification records; the slowest one counts.
  const p95 = (modelId: string) => {
    const q = state.qualifications.filter((x) => x.modelId === modelId && x.task === req.task);
    return q.length ? Math.max(...q.map((x) => x.p95LatencyMs)) : null;
  };

  const eligible: Candidate[] = [];
  const excluded: Exclusion[] = [];
  for (const m of models) {
    const cost = estimateCostMicroInr(m, req.estimatedInputTokens, req.estimatedOutputTokens);
    const latency = p95(m.id);
    const reason: ExclusionReason | null =
      localityAllowed(policy, task, m.locality, req.dataClass) ??
      (task.pinnedModelId !== undefined && task.pinnedModelId !== m.id ? 'NOT_PINNED' : null) ??
      (req.capabilities.every((c) => m.capabilities.includes(c)) ? null : 'CAPABILITY') ??
      (m.contextTokens >= req.estimatedInputTokens + req.estimatedOutputTokens
        ? null
        : 'CONTEXT_TOO_SMALL') ??
      (providerOk(m.providerId) ? null : 'PROVIDER_UNAVAILABLE') ??
      (latency === null ? 'NOT_QUALIFIED' : null) ??
      (req.maxCostMicroInr !== undefined && cost > req.maxCostMicroInr ? 'COST' : null) ??
      (m.locality === 'CLOUD' &&
      state.cloudSpentThisMonthMicroInr + cost > policy.monthlyCloudBudgetMicroInr
        ? 'MONTHLY_BUDGET'
        : null) ??
      (req.maxLatencyMs !== undefined && latency !== null && latency > req.maxLatencyMs
        ? 'LATENCY'
        : null);
    if (reason) excluded.push({ modelId: m.id, reason });
    else
      eligible.push({
        modelId: m.id,
        providerId: m.providerId,
        locality: m.locality,
        estimatedCostMicroInr: cost,
        p95LatencyMs: latency ?? 0,
      });
  }

  const cloudFirst =
    policy.mode === 'CLOUD' || (policy.mode === 'HYBRID' && task.preference === 'CLOUD_FIRST');
  const localityRank = (c: Candidate) => ((c.locality === 'CLOUD') === cloudFirst ? 0 : 1);
  eligible.sort(
    (a, b) =>
      localityRank(a) - localityRank(b) ||
      (a.estimatedCostMicroInr < b.estimatedCostMicroInr
        ? -1
        : a.estimatedCostMicroInr > b.estimatedCostMicroInr
          ? 1
          : 0) ||
      a.p95LatencyMs - b.p95LatencyMs ||
      (a.modelId < b.modelId ? -1 : 1),
  );

  if (eligible.length === 0) {
    const reason = excluded.every((e) => POLICY_REASONS.has(e.reason))
      ? 'POLICY_BLOCKED'
      : excluded.some((e) => e.reason === 'COST' || e.reason === 'MONTHLY_BUDGET')
        ? 'BUDGET_EXCEEDED'
        : 'AI_UNAVAILABLE';
    return { ok: false, reason, excluded, policyVersion };
  }
  return {
    ok: true,
    candidates: task.fallback ? eligible : eligible.slice(0, 1),
    excluded,
    policyVersion,
  };
}

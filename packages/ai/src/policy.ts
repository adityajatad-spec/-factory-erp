import {
  AI_DATA_CLASS_CEILING,
  AI_POLICY_TASKS,
  CompanyAiPolicySchema,
  withinDataClass,
  type AiPolicyTask,
  type AiTaskRules,
  type CompanyAiPolicy,
  type DataClass,
} from '@factory-erp/contracts';
import type { AiPolicy, Qualification, Task } from './types';

/**
 * A company's AI policy — the only thing that can let company data reach a model.
 *
 * It is DATA, owned by the company: append-only versions in `ai.policy_versions`, changed only
 * by the audited OWNER command `ai.policy.set` (copilot module). Nothing else is a policy source: environment settings say which local
 * runtime and model are installed, never what may be done with company data.
 *
 * Validation does not rely on object identity or on TypeScript types: every use (each model
 * call, each tool filter) re-validates the policy's content against the schema and the company
 * the caller is acting in (`validPolicyFor`). Anything missing, invalid or for another company
 * means "AI off". `resolveAiPolicy` additionally returns a deep-frozen copy.
 *
 * FRESHNESS AND PROVENANCE are the caller's contract, enforced in P1/B2, not here: the server
 * must resolve the company's CURRENT stored policy for every model call and every tool
 * execution (never cache one across operations), so a revocation applies to the next operation.
 * A schema-valid object built in code passes these checks; only server code can build one, and
 * the copilot runtime must take policy only from the P1 store.
 */

/** Tasks a policy may enable in this slice (the schema itself lives in @factory-erp/contracts). */
export const SUPPORTED_AI_TASKS = AI_POLICY_TASKS satisfies readonly Task[];
export type SupportedAiTask = AiPolicyTask;
export { AI_DATA_CLASS_CEILING, CompanyAiPolicySchema };
export type { AiTaskRules, CompanyAiPolicy };

declare const RESOLVED: unique symbol;

/** A validated, frozen policy for one company (the brand is compile-time only). */
export type ResolvedAiPolicy = Readonly<CompanyAiPolicy> & { readonly [RESOLVED]: true };

export type PolicyFailure = 'POLICY_MISSING' | 'POLICY_INVALID' | 'POLICY_COMPANY_MISMATCH';

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** Validate a stored policy for the company the caller is acting in. Fails closed. */
export function resolveAiPolicy(
  raw: unknown,
  expectedCompanyId: string,
): { ok: true; policy: ResolvedAiPolicy } | { ok: false; reason: PolicyFailure } {
  if (raw === null || raw === undefined) return { ok: false, reason: 'POLICY_MISSING' };
  const parsed = CompanyAiPolicySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'POLICY_INVALID' };
  if (parsed.data.companyId !== expectedCompanyId) {
    return { ok: false, reason: 'POLICY_COMPANY_MISMATCH' };
  }
  return { ok: true, policy: deepFreeze(parsed.data) as ResolvedAiPolicy };
}

/**
 * Re-validate a policy at the point of use: its full content against the schema, and its
 * company against the company the caller is acting in. Null means "AI off". Independent of
 * object identity, so it holds whatever module instance produced the object.
 */
export function validPolicyFor(policy: unknown, companyId: string): CompanyAiPolicy | null {
  if (policy === null || typeof policy !== 'object') return null;
  const parsed = CompanyAiPolicySchema.safeParse(policy);
  return parsed.success && parsed.data.companyId === companyId ? parsed.data : null;
}

/**
 * The rules for a task, if — and only if — the policy re-validates, belongs to the company, has
 * AI switched on and enables that task. Otherwise null (AI off for the request).
 */
export function taskRules(
  policy: unknown,
  companyId: string,
  task: Task,
): (AiTaskRules & { policyVersion: number }) | null {
  const valid = validPolicyFor(policy, companyId);
  if (!valid?.aiEnabled) return null;
  const rules = (valid.tasks as Partial<Record<Task, AiTaskRules>>)[task];
  return rules ? { ...rules, policyVersion: valid.version } : null;
}

/** May data of this class be used for the task under this policy? */
export function policyAllowsDataClass(rules: AiTaskRules, dataClass: DataClass): boolean {
  return dataClass !== 'RESTRICTED' && withinDataClass(dataClass, rules.maxDataClass);
}

/**
 * The router's view of one task's rules: local only, cloud off, the policy's data ceiling,
 * and qualifications only for the models the policy approves.
 */
export function routingInputsFor(
  task: Task,
  rules: AiTaskRules & { policyVersion: number },
): { policy: AiPolicy; qualifications: Qualification[] } {
  return {
    policy: {
      version: rules.policyVersion,
      mode: 'LOCAL',
      cloudEnabled: false,
      monthlyCloudBudgetMicroInr: 0n,
      tasks: {
        [task]: {
          maxLocalDataClass: rules.maxDataClass,
          maxCloudDataClass: null,
          preference: 'LOCAL_FIRST',
          fallback: rules.fallback,
        },
      },
    },
    qualifications: rules.approvedModels.map((m) => ({
      modelId: m.modelId,
      task,
      p95LatencyMs: m.p95LatencyMs,
    })),
  };
}

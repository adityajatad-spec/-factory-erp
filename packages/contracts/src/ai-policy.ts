import { z } from 'zod';
import type { DataClass } from './data-class';

/**
 * A company's AI policy (Slice 2) — the only thing that can let company data reach a model.
 * Stored as append-only versions; changed only by the OWNER through `ai.policy.set`; never by
 * the AI. Shared here so the copilot module (which stores it) and the AI layer (which enforces
 * it) validate with one schema. Local inference only: there is no cloud setting to turn on.
 */

/** Tasks a policy may enable. Any other task key makes the policy invalid. */
export const AI_POLICY_TASKS = ['copilot.answer'] as const;
export type AiPolicyTask = (typeof AI_POLICY_TASKS)[number];

/** The highest data class a policy may allow at all: RESTRICTED is never permitted. */
export const AI_DATA_CLASS_CEILING = 'CONFIDENTIAL' as const satisfies DataClass;
const PERMITTED_DATA_CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'] as const;

const ApprovedModel = z
  .object({
    /** Gateway model id, e.g. "ollama:qwen2.5:7b". Approval is per task. */
    modelId: z.string().trim().min(1).max(120),
    /** Expected 95th-percentile latency for the task on this hardware (owner-asserted for now). */
    p95LatencyMs: z.number().int().positive().max(600_000),
  })
  .strict();

export const AiTaskRulesSchema = z
  .object({
    maxDataClass: z.enum(PERMITTED_DATA_CLASSES),
    approvedModels: z
      .array(ApprovedModel)
      .max(10)
      .refine((ms) => new Set(ms.map((m) => m.modelId)).size === ms.length, 'Each model only once'),
    /** Try the next approved model if the first fails (never another locality). */
    fallback: z.boolean(),
  })
  .strict();

export const AiPolicyTasksSchema = z.partialRecord(z.enum(AI_POLICY_TASKS), AiTaskRulesSchema);

/** A complete, stored policy. */
export const CompanyAiPolicySchema = z
  .object({
    companyId: z.uuid(),
    version: z.number().int().min(1),
    /** Company-wide kill switch. */
    aiEnabled: z.boolean(),
    /** This slice has no cloud inference: both are fixed, and anything else is invalid. */
    locality: z.literal('LOCAL_ONLY'),
    cloudEnabled: z.literal(false),
    tasks: AiPolicyTasksSchema,
  })
  .strict();

export type CompanyAiPolicy = z.infer<typeof CompanyAiPolicySchema>;
export type AiTaskRules = z.infer<typeof AiTaskRulesSchema>;

/**
 * Set the next policy version. Company and version come from the server, never the request:
 * `expectedVersion` is the version the owner is replacing (0 when there is none yet).
 */
export const SetAiPolicyRequest = z
  .object({
    expectedVersion: z.number().int().min(0),
    aiEnabled: z.boolean(),
    locality: z.literal('LOCAL_ONLY').default('LOCAL_ONLY'),
    cloudEnabled: z.literal(false).default(false),
    tasks: AiPolicyTasksSchema,
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500),
  })
  .strict();
export type SetAiPolicyRequest = z.input<typeof SetAiPolicyRequest>;

/** The latest stored policy (null when the company has none: AI off). */
export interface AiPolicyDto {
  companyId: string;
  version: number;
  aiEnabled: boolean;
  locality: 'LOCAL_ONLY';
  cloudEnabled: false;
  /** Raw stored rules; consumers re-validate with CompanyAiPolicySchema before use. */
  tasks: unknown;
  reason: string;
  createdAt: string;
  createdByName: string | null;
}

/**
 * What the user-facing policy endpoint returns. Everyone signed in sees whether AI is on and,
 * per enabled task, the highest data class; only policy managers (the owner) also get `detail`
 * — approved models, latency expectations, the reason and who changed it.
 */
export interface AiPolicyViewDto {
  version: number;
  aiEnabled: boolean;
  locality: 'LOCAL_ONLY';
  cloudEnabled: false;
  updatedAt: string;
  /** False if the stored version fails the contract (then AI is off regardless). */
  valid: boolean;
  tasks: Array<{ task: AiPolicyTask; maxDataClass: AiTaskRules['maxDataClass'] }>;
  detail: { tasks: unknown; reason: string; createdByName: string | null } | null;
}

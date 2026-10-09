import {
  AiPolicyTasksSchema,
  PERMISSIONS,
  type AiPolicyDto,
  type AiPolicyTask,
  type AiPolicyViewDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { defineQuery } from '../../platform/queries';
import { loadLatestPolicy } from './policy-store';

/**
 * The company's latest AI policy as stored (null: none, AI off). SERVER-SIDE ONLY: the policy
 * resolver reads it for the signed-in user before AI work; it is not exposed over HTTP (people
 * get `ai.policy.view`) and never to the AI. Consumers must re-validate it with
 * the shared contract before use; this query does not vouch for the content.
 */
export const getAiPolicy = defineQuery({
  name: 'ai.policy.get',
  description: "The company's current AI policy version (null if none: AI is off).",
  input: z.object({}).strict(),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'FORBIDDEN' },
  dataClass: 'INTERNAL',
  handler: ({ db, companyId }): Promise<AiPolicyDto | null> => loadLatestPolicy(db, companyId),
});

/**
 * The policy as shown to people: the minimal view for everyone, plus `detail` (approved models,
 * latency expectations, reason, editor) only for holders of ai.policy.manage. Never for the AI.
 */
export const viewAiPolicy = defineQuery({
  name: 'ai.policy.view',
  description: 'Whether AI is on for the company and, per task, the data it may see.',
  input: z.object({}).strict(),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'FORBIDDEN' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId, can }): Promise<AiPolicyViewDto | null> => {
    const stored = await loadLatestPolicy(db, companyId);
    if (!stored) return null;
    const tasks = AiPolicyTasksSchema.safeParse(stored.tasks);
    return {
      version: stored.version,
      aiEnabled: stored.aiEnabled,
      locality: stored.locality,
      cloudEnabled: stored.cloudEnabled,
      updatedAt: stored.createdAt,
      valid: tasks.success,
      tasks: tasks.success
        ? Object.entries(tasks.data).flatMap(([task, rules]) =>
            rules ? [{ task: task as AiPolicyTask, maxDataClass: rules.maxDataClass }] : [],
          )
        : [],
      detail: can(PERMISSIONS.aiPolicyManage)
        ? { tasks: stored.tasks, reason: stored.reason, createdByName: stored.createdByName }
        : null,
    };
  },
});

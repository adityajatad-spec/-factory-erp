import {
  CompanyAiPolicySchema,
  PERMISSIONS,
  SetAiPolicyRequest,
  type AiPolicyDto,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import { defineCommand } from '../../platform/commands';
import { ForbiddenError, ValidationError, VersionConflictError } from '../../platform/errors';
import { toJsonb } from '../../platform/json';
import { zodIssues } from '../../platform/validation';
import { loadLatestPolicy } from './policy-store';

/** What the audit trail records about a policy version (it holds no secrets). */
const auditView = (
  p: Pick<AiPolicyDto, 'version' | 'aiEnabled' | 'locality' | 'cloudEnabled' | 'tasks'>,
) => ({
  version: p.version,
  aiEnabled: p.aiEnabled,
  locality: p.locality,
  cloudEnabled: p.cloudEnabled,
  tasks: p.tasks,
});

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

/**
 * Set the company's next AI policy version. OWNER only (the permission is withheld from ADMIN
 * and the handler checks the role as well); never available to the AI. The company and the
 * new version number come from the session and the database — never from the request.
 * Concurrent changes serialise on a per-company lock; the loser gets a version conflict.
 */
export const setAiPolicy = defineCommand({
  name: 'ai.policy.set',
  description:
    'Set the company AI policy (owner only): whether AI is on, which local models are approved per task, and the highest data class they may see.',
  input: SetAiPolicyRequest,
  permission: PERMISSIONS.aiPolicyManage,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    if (!actor.user.roles.includes('OWNER')) {
      throw new ForbiddenError('the OWNER role (only the owner can change the AI policy)');
    }
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ai.policy:${companyId}`}, 0))`.execute(
      tx,
    );
    const current = await loadLatestPolicy(tx, companyId);
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion) throw new VersionConflictError('AI policy');

    // The whole next policy must satisfy the shared contract (company and version included).
    const next = CompanyAiPolicySchema.safeParse({
      companyId,
      version: currentVersion + 1,
      aiEnabled: input.aiEnabled,
      locality: input.locality,
      cloudEnabled: input.cloudEnabled,
      tasks: input.tasks,
    });
    if (!next.success) throw new ValidationError(zodIssues(next.error));

    try {
      await tx
        .insertInto('ai.policyVersions')
        .values({
          companyId,
          version: next.data.version,
          aiEnabled: next.data.aiEnabled,
          locality: next.data.locality,
          cloudEnabled: next.data.cloudEnabled,
          tasks: toJsonb(next.data.tasks),
          reason: input.reason,
          createdAt: now,
          createdBy: actor.user.id,
        })
        .execute();
    } catch (e) {
      // Backstop if the lock were ever bypassed: the primary key refuses a duplicate version.
      if (isUniqueViolation(e)) throw new VersionConflictError('AI policy');
      throw e;
    }

    const saved = await loadLatestPolicy(tx, companyId);
    if (!saved) throw new Error('policy version not readable after insert');
    return {
      result: saved,
      audit: [
        {
          entityType: 'ai.policy',
          entityId: companyId,
          before: current ? auditView(current) : null,
          after: { ...auditView(saved), reason: input.reason },
        },
      ],
    };
  },
});

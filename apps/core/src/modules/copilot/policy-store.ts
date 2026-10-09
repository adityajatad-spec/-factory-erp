import type { AiPolicyDto } from '@factory-erp/contracts';
import type { DbExecutor } from '../../db/database';

/** The latest stored policy version of a company, or null (no policy: AI off). */
export async function loadLatestPolicy(
  db: DbExecutor,
  companyId: string,
): Promise<AiPolicyDto | null> {
  const row = await db
    .selectFrom('ai.policyVersions as p')
    .leftJoin('identity.users as u', 'u.id', 'p.createdBy')
    .select([
      'p.companyId',
      'p.version',
      'p.aiEnabled',
      'p.locality',
      'p.cloudEnabled',
      'p.tasks',
      'p.reason',
      'p.createdAt',
      'u.displayName as createdByName',
    ])
    .where('p.companyId', '=', companyId)
    .orderBy('p.version', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    companyId: row.companyId,
    version: row.version,
    aiEnabled: row.aiEnabled,
    // Returned as stored; consumers re-validate the whole policy before any use.
    locality: row.locality as 'LOCAL_ONLY',
    cloudEnabled: row.cloudEnabled as false,
    tasks: row.tasks,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
  };
}

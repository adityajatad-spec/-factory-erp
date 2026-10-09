import { resolveAiPolicy, type PolicyFailure, type ResolvedAiPolicy } from '@factory-erp/ai';
import type { AiPolicyDto } from '@factory-erp/contracts';
import { getAiPolicy } from '../modules/copilot';
import type { AuthenticatedActor } from '../platform/actor';
import type { QueryBus, QueryOptions } from '../platform/queries';

/**
 * The policy itself out of a stored version (dropping who/when/why), so the strict contract
 * validates exactly the policy fields. Null stays null: no policy, AI off.
 */
export function policyContent(stored: AiPolicyDto | null): unknown {
  if (!stored) return null;
  return {
    companyId: stored.companyId,
    version: stored.version,
    aiEnabled: stored.aiEnabled,
    locality: stored.locality,
    cloudEnabled: stored.cloudEnabled,
    tasks: stored.tasks,
  };
}

export type PolicyResolution =
  | { ok: true; policy: ResolvedAiPolicy }
  | { ok: false; reason: PolicyFailure | 'POLICY_UNAVAILABLE'; version: null };

/**
 * Resolve the CURRENT AI policy of the signed-in user's company: read the latest stored version
 * through the query bus (as the human user — the query is forbidden to the AI actor), then
 * validate it against that same company. Anything else fails closed. Call it for EVERY model
 * call and every tool execution; never cache the result across operations.
 */
export async function resolveCompanyPolicy(
  queries: Pick<QueryBus, 'execute'>,
  actor: AuthenticatedActor,
  opts: QueryOptions = {},
): Promise<PolicyResolution> {
  // Policy is read on behalf of the person, never by an AI actor.
  if (actor.actorKind !== 'user') return { ok: false, reason: 'POLICY_UNAVAILABLE', version: null };
  let stored: AiPolicyDto | null;
  try {
    stored = await queries.execute(getAiPolicy, {}, actor, opts);
  } catch {
    return { ok: false, reason: 'POLICY_UNAVAILABLE', version: null };
  }
  const r = resolveAiPolicy(policyContent(stored), actor.user.companyId);
  // A version is never reported from content that failed validation.
  return r.ok ? r : { ok: false, reason: r.reason, version: null };
}

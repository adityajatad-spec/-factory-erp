import type { Permission, RoleCode } from '@factory-erp/contracts';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  companyId: string;
  sessionId: string;
  roles: readonly RoleCode[];
  permissions: ReadonlySet<Permission>;
  /** An administrator set this password: only changing it is allowed until then. */
  mustChangePassword: boolean;
}

/**
 * Who is acting, and through which channel. The AI copilot will execute commands with
 * `actorKind: 'ai_agent'` *on behalf of a user* — with exactly that user's permissions.
 * There is no separate privileged path.
 */
export interface Actor {
  requestId: string;
  user: AuthenticatedUser | null;
  actorKind: 'user' | 'ai_agent' | 'system';
  aiSessionId?: string;
}

/** An actor known to be signed in (commands and queries only ever receive this). */
export interface AuthenticatedActor extends Actor {
  user: AuthenticatedUser;
}

/** Background work (outbox handlers, scheduled jobs) acts as the system, never as a user. */
export interface SystemActor {
  requestId: string;
  user: null;
  actorKind: 'system';
}

export function systemActor(requestId: string): SystemActor {
  return { requestId, user: null, actorKind: 'system' };
}

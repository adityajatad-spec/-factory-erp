import { isPermission, ROLE_CODES, type Permission, type RoleCode } from '@factory-erp/contracts';
import { createHash, randomBytes } from 'node:crypto';
import type { Database, DbExecutor } from '../../db/database';
import type { AuthenticatedUser } from '../../platform/actor';
import { uuidv7 } from '../../platform/ids';

export const SESSION_COOKIE = 'ferp_session';

/** Session tokens are random 256-bit values; only their SHA-256 is stored. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export async function createSession(
  db: DbExecutor,
  args: {
    userId: string;
    companyId: string;
    ttlHours: number;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const sessionId = uuidv7(args.now.getTime());
  const expiresAt = new Date(args.now.getTime() + args.ttlHours * 3_600_000);
  await db
    .insertInto('identity.sessions')
    .values({
      id: sessionId,
      userId: args.userId,
      companyId: args.companyId,
      tokenHash: hashToken(token),
      createdAt: args.now,
      lastSeenAt: args.now,
      expiresAt,
      ip: args.ip,
      userAgent: args.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { sessionId, token, expiresAt };
}

export async function loadAccess(
  db: DbExecutor,
  userId: string,
  companyId: string,
): Promise<{ roles: RoleCode[]; permissions: Set<Permission> }> {
  const rows = await db
    .selectFrom('identity.userRoles as ur')
    .leftJoin('identity.rolePermissions as rp', 'rp.roleCode', 'ur.roleCode')
    .select(['ur.roleCode', 'rp.permission'])
    .where('ur.userId', '=', userId)
    .where('ur.companyId', '=', companyId)
    .execute();

  const roles = new Set<RoleCode>();
  const permissions = new Set<Permission>();
  for (const r of rows) {
    if ((ROLE_CODES as readonly string[]).includes(r.roleCode)) roles.add(r.roleCode as RoleCode);
    // Unknown codes in the database are ignored, never trusted.
    if (r.permission && isPermission(r.permission)) permissions.add(r.permission);
  }
  return { roles: [...roles], permissions };
}

const TOUCH_INTERVAL_MS = 60_000;

/** Resolve a session token to the signed-in user, or null if invalid, expired or revoked. */
export async function resolveSession(
  db: Database,
  token: string,
  now: Date,
): Promise<AuthenticatedUser | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await db
    .selectFrom('identity.sessions as s')
    .innerJoin('identity.users as u', 'u.id', 's.userId')
    .select([
      's.id as sessionId',
      's.companyId',
      's.lastSeenAt',
      'u.id as userId',
      'u.username',
      'u.displayName',
    ])
    .where('s.tokenHash', '=', hashToken(token))
    .where('s.revokedAt', 'is', null)
    .where('s.expiresAt', '>', now)
    .where('u.status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .updateTable('identity.sessions')
      .set({ lastSeenAt: now })
      .where('id', '=', row.sessionId)
      .execute();
  }

  const access = await loadAccess(db, row.userId, row.companyId);
  return {
    id: row.userId,
    username: row.username,
    displayName: row.displayName,
    companyId: row.companyId,
    sessionId: row.sessionId,
    roles: access.roles,
    permissions: access.permissions,
  };
}

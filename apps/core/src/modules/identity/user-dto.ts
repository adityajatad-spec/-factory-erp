import { ROLE_CODES, type RoleCode, type UserDto } from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';
import { NotFoundError } from '../../platform/errors';

const isRole = (r: string): r is RoleCode => (ROLE_CODES as readonly string[]).includes(r);

/** Users of a company with their roles, last sign-in and recent failures. */
export function selectUsers(db: DbExecutor, companyId: string, now: Date) {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  return db
    .selectFrom('identity.users as u')
    .select([
      'u.id',
      'u.username',
      'u.displayName',
      'u.status',
      'u.mustChangePassword',
      'u.version',
      sql<string[]>`array(select ur.role_code from identity.user_roles ur
        where ur.user_id = u.id and ur.company_id = ${companyId} order by ur.role_code)`.as(
        'roles',
      ),
      sql<Date | null>`(select max(a.attempted_at) from identity.login_attempts a
        where a.user_id = u.id and a.outcome = 'SUCCESS')`.as('lastSignInAt'),
      sql<string>`(select count(*) from identity.login_attempts a
        where a.user_id = u.id and a.outcome <> 'SUCCESS' and a.attempted_at > ${dayAgo})`.as(
        'failedSignIns',
      ),
    ])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('identity.userRoles as m')
          .select('m.userId')
          .whereRef('m.userId', '=', 'u.id')
          .where('m.companyId', '=', companyId),
      ),
    );
}

type UserRow = Awaited<ReturnType<ReturnType<typeof selectUsers>['executeTakeFirstOrThrow']>>;

export function toUserDto(r: UserRow): UserDto {
  return {
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    roles: r.roles.filter(isRole),
    mustChangePassword: r.mustChangePassword,
    lastSignInAt: r.lastSignInAt ? r.lastSignInAt.toISOString() : null,
    failedSignInsLast24h: Number(r.failedSignIns),
    version: r.version,
  };
}

export async function loadUser(tx: DbExecutor, companyId: string, userId: string, now: Date) {
  const row = await selectUsers(tx, companyId, now).where('u.id', '=', userId).executeTakeFirst();
  if (!row) throw new NotFoundError('User');
  return toUserDto(row);
}

import { LoginRequest, type SessionUser } from '@factory-erp/contracts';
import type { Database } from '../../db/database';
import type { AuthenticatedActor } from '../../platform/actor';
import { writeAudit } from '../../platform/audit';
import type { Clock } from '../../platform/clock';
import { InvalidCredentialsError, ValidationError } from '../../platform/errors';
import { zodIssues } from '../../platform/validation';
import { dummyPasswordHash, verifyPassword } from './password';
import { createSession, loadAccess } from './sessions';

/**
 * Login and logout. These are not ordinary commands (there is no authenticated actor before
 * login), but they follow the same rules: validated input, one transaction, audited.
 */
export class AuthService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #sessionTtlHours: number;

  constructor(deps: { db: Database; clock: Clock; sessionTtlHours: number }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#sessionTtlHours = deps.sessionTtlHours;
  }

  async login(
    raw: unknown,
    meta: { requestId: string; ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; expiresAt: Date; user: SessionUser }> {
    const parsed = LoginRequest.safeParse(raw);
    if (!parsed.success) throw new ValidationError(zodIssues(parsed.error));
    const { username, password } = parsed.data;

    const user = await this.#db
      .selectFrom('identity.users')
      .select(['id', 'username', 'displayName', 'passwordHash', 'status'])
      .where('username', '=', username)
      .executeTakeFirst();

    // Always run one hash verification so timing does not reveal whether the user exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok || user.status !== 'ACTIVE') throw new InvalidCredentialsError();

    const membership = await this.#db
      .selectFrom('identity.userRoles')
      .select('companyId')
      .where('userId', '=', user.id)
      .orderBy('companyId')
      .executeTakeFirst();
    if (!membership) throw new InvalidCredentialsError();

    const now = this.#clock.now();
    const session = await this.#db.transaction().execute(async (tx) => {
      const s = await createSession(tx, {
        userId: user.id,
        companyId: membership.companyId,
        ttlHours: this.#sessionTtlHours,
        now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      const actor = await this.#actor(tx, user, membership.companyId, s.sessionId, meta.requestId);
      await writeAudit(
        tx,
        [{ entityType: 'identity.session', entityId: s.sessionId, after: { ip: meta.ip } }],
        {
          actor,
          command: 'identity.session.create',
          companyId: membership.companyId,
          occurredAt: now,
        },
      );
      return s;
    });

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: await this.sessionUser(user.id, membership.companyId),
    };
  }

  async logout(actor: AuthenticatedActor): Promise<void> {
    const now = this.#clock.now();
    await this.#db.transaction().execute(async (tx) => {
      await tx
        .updateTable('identity.sessions')
        .set({ revokedAt: now })
        .where('id', '=', actor.user.sessionId)
        .where('revokedAt', 'is', null)
        .execute();
      await writeAudit(tx, [{ entityType: 'identity.session', entityId: actor.user.sessionId }], {
        actor,
        command: 'identity.session.revoke',
        companyId: actor.user.companyId,
        occurredAt: now,
      });
    });
  }

  async sessionUser(userId: string, companyId: string): Promise<SessionUser> {
    const row = await this.#db
      .selectFrom('identity.users as u')
      .innerJoin('platform.companies as c', (j) => j.on('c.id', '=', companyId))
      .select([
        'u.id',
        'u.username',
        'u.displayName',
        'c.id as companyId',
        'c.legalName',
        'c.tradeName',
        'c.isDemo',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirstOrThrow();
    const access = await loadAccess(this.#db, userId, companyId);
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      roles: access.roles,
      permissions: [...access.permissions].sort(),
      company: {
        id: row.companyId,
        legalName: row.legalName,
        tradeName: row.tradeName,
        isDemo: row.isDemo,
      },
    };
  }

  async #actor(
    tx: Parameters<typeof loadAccess>[0],
    user: { id: string; username: string; displayName: string },
    companyId: string,
    sessionId: string,
    requestId: string,
  ): Promise<AuthenticatedActor> {
    const access = await loadAccess(tx, user.id, companyId);
    return {
      requestId,
      actorKind: 'user',
      user: { ...user, companyId, sessionId, roles: access.roles, permissions: access.permissions },
    };
  }
}

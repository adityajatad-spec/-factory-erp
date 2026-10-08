import { LoginRequest, type SessionUser } from '@factory-erp/contracts';
import type { Database } from '../../db/database';
import type { Actor, AuthenticatedActor } from '../../platform/actor';
import { writeAudit } from '../../platform/audit';
import type { Clock } from '../../platform/clock';
import {
  InvalidCredentialsError,
  TooManyAttemptsError,
  ValidationError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { zodIssues } from '../../platform/validation';
import { dummyPasswordHash, verifyPassword } from './password';
import { createSession, loadAccess } from './sessions';
import { ATTEMPT_WINDOW_MS, signInDelayMs, type AttemptOutcome } from './sign-in-backoff';

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
    const now = this.#clock.now();

    const user = await this.#db
      .selectFrom('identity.users')
      .select(['id', 'username', 'displayName', 'passwordHash', 'status'])
      .where('username', '=', username)
      .executeTakeFirst();
    const membership = user
      ? await this.#db
          .selectFrom('identity.userRoles')
          .select('companyId')
          .where('userId', '=', user.id)
          .orderBy('companyId')
          .executeTakeFirst()
      : undefined;
    const fail = async (outcome: AttemptOutcome) =>
      this.#recordFailure({ username, user, companyId: membership?.companyId, outcome, now, meta });

    // Backoff first, before any password check, so a waiting username cannot be probed.
    const recent = await this.#db
      .selectFrom('identity.loginAttempts')
      .select(['outcome', 'attemptedAt'])
      .where('username', '=', username)
      .where('attemptedAt', '>', new Date(now.getTime() - ATTEMPT_WINDOW_MS))
      .orderBy('attemptedAt', 'desc')
      .limit(50)
      .execute();
    const waitMs = signInDelayMs(recent, now);
    if (waitMs > 0) {
      await fail('LOCKED_OUT');
      throw new TooManyAttemptsError(Math.ceil(waitMs / 1000));
    }

    // Always run one hash verification so timing does not reveal whether the user exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok || !membership) {
      await fail('BAD_CREDENTIALS');
      throw new InvalidCredentialsError();
    }
    if (user.status !== 'ACTIVE') {
      await fail('DISABLED');
      throw new InvalidCredentialsError();
    }

    const session = await this.#db.transaction().execute(async (tx) => {
      const s = await createSession(tx, {
        userId: user.id,
        companyId: membership.companyId,
        ttlHours: this.#sessionTtlHours,
        now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await tx
        .insertInto('identity.loginAttempts')
        .values({
          id: uuidv7(now.getTime()),
          attemptedAt: now,
          username,
          userId: user.id,
          outcome: 'SUCCESS',
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        })
        .execute();
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

  /** Record a refused sign-in; for a known user, also in the company's audit trail. */
  async #recordFailure(args: {
    username: string;
    user: { id: string } | undefined;
    companyId: string | undefined;
    outcome: AttemptOutcome;
    now: Date;
    meta: { requestId: string; ip: string | null; userAgent: string | null };
  }): Promise<void> {
    const { username, user, companyId, outcome, now, meta } = args;
    await this.#db.transaction().execute(async (tx) => {
      await tx
        .insertInto('identity.loginAttempts')
        .values({
          id: uuidv7(now.getTime()),
          attemptedAt: now,
          username,
          userId: user?.id ?? null,
          outcome,
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        })
        .execute();
      if (user && companyId) {
        const anonymous: Actor = { requestId: meta.requestId, user: null, actorKind: 'user' };
        await writeAudit(
          tx,
          [{ entityType: 'identity.user', entityId: user.id, metadata: { outcome, ip: meta.ip } }],
          { actor: anonymous, command: 'identity.session.refused', companyId, occurredAt: now },
        );
      }
    });
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
        'u.mustChangePassword',
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
      mustChangePassword: row.mustChangePassword,
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
      user: {
        ...user,
        companyId,
        sessionId,
        roles: access.roles,
        permissions: access.permissions,
        mustChangePassword: false,
      },
    };
  }
}

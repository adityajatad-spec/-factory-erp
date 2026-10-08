import { CreateUserRequest, omitRestricted, type RoleCode } from '@factory-erp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, TEST_PASSWORD, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { AuthenticatedActor } from '../../platform/actor';
import type { Clock } from '../../platform/clock';
import {
  BusinessRuleError,
  ForbiddenError,
  InvalidCredentialsError,
  PasswordChangeRequiredError,
  TooManyAttemptsError,
} from '../../platform/errors';
import { canonicalJson, sha256Hex } from '../../platform/json';
import { getCompany } from '../company';
import {
  changeOwnPassword,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetUserPassword,
  setUserRoles,
} from './index';
import { resolveSession } from './sessions';

/** A clock the backoff test can move forward. */
class TestClock implements Clock {
  at = new Date('2026-10-05T09:30:00Z');
  now(): Date {
    return new Date(this.at.getTime());
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}
const clock = new TestClock();

let env: TestEnv;
let fx: Fixture;
const cmd = () => env.services.commands;
const owner = () => fx.actors.owner;
const meta = { requestId: 'test-login', ip: '10.0.0.7', userAgent: 'vitest' };

beforeAll(async () => {
  env = await createTestEnv({ clock });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

async function newUser(username: string, roles: RoleCode[], by: AuthenticatedActor = owner()) {
  return cmd().execute(
    createUser,
    { username, displayName: username, roles, initialPassword: `first-${username}-pass` },
    by,
  );
}
/** Sign in for real and return the actor the server would build from the session cookie. */
async function signIn(username: string, password: string): Promise<AuthenticatedActor> {
  const { token } = await env.services.auth.login({ username, password }, meta);
  const user = await resolveSession(env.services.db, token, clock.now());
  if (!user) throw new Error('no session');
  return { requestId: 'test', user, actorKind: 'user' };
}
const users = () => env.services.queries.execute(listUsers, {}, owner());
const userRow = async (username: string) => {
  const u = (await users()).find((x) => x.username === username);
  if (!u) throw new Error(`${username} not listed`);
  return u;
};

describe('creating users and first sign-in', () => {
  it('creates a user who must choose a password before doing anything else', async () => {
    const u = await newUser('ravi', ['ACCOUNTANT']);
    expect(u).toMatchObject({
      username: 'ravi',
      roles: ['ACCOUNTANT'],
      status: 'ACTIVE',
      mustChangePassword: true,
    });

    const ravi = await signIn('ravi', 'first-ravi-pass');
    expect(ravi.user.mustChangePassword).toBe(true);
    await expect(env.services.queries.execute(getCompany, {}, ravi)).rejects.toBeInstanceOf(
      PasswordChangeRequiredError,
    );

    await cmd().execute(
      changeOwnPassword,
      { currentPassword: 'first-ravi-pass', newPassword: 'my own phrase 2026' },
      ravi,
    );
    const again = await signIn('ravi', 'my own phrase 2026');
    expect(again.user.mustChangePassword).toBe(false);
    await expect(env.services.queries.execute(getCompany, {}, again)).resolves.toBeDefined();
  });

  it('never stores or audits a password, and keeps it out of the idempotency hash', async () => {
    const input = {
      username: 'secretive',
      displayName: 'S',
      roles: ['WORKER'] as RoleCode[],
      initialPassword: 'p4ssword-in-plain-sight',
    };
    await cmd().execute(createUser, input, owner(), { idempotencyKey: 'create-user-secret-1' });
    const dump = await env.ownerDb
      .selectFrom('system.idempotencyKeys')
      .select(['requestHash', 'response'])
      .where('key', '=', 'create-user-secret-1')
      .executeTakeFirstOrThrow();
    const audit = await env.ownerDb
      .selectFrom('audit.events')
      .select(['before', 'after', 'metadata'])
      .execute();
    const everything = JSON.stringify({ dump, audit });
    expect(everything).not.toContain('p4ssword-in-plain-sight');
    expect(dump.requestHash).toBe(
      sha256Hex(
        canonicalJson({
          command: 'identity.user.create',
          input: omitRestricted(CreateUserRequest, CreateUserRequest.parse(input)),
        }),
      ),
    );
    const hash = await env.ownerDb
      .selectFrom('identity.users')
      .select('passwordHash')
      .where('username', '=', 'secretive')
      .executeTakeFirstOrThrow();
    expect(hash.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('refuses a taken username', async () => {
    await expect(newUser('ravi', ['WORKER'])).rejects.toThrow(/already taken/);
  });
});

describe('who may manage whom', () => {
  it('nobody administers themselves', async () => {
    const me = await userRow(owner().user.username);
    for (const attempt of [
      () =>
        cmd().execute(
          setUserRoles,
          { userId: me.id, expectedVersion: me.version, roles: ['WORKER'] },
          owner(),
        ),
      () => cmd().execute(deactivateUser, { userId: me.id, expectedVersion: me.version }, owner()),
      () =>
        cmd().execute(
          resetUserPassword,
          { userId: me.id, expectedVersion: me.version, temporaryPassword: 'self service!' },
          owner(),
        ),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ rule: 'SELF_ADMINISTRATION' });
    }
  });

  it('an administrator cannot create, promote, demote, deactivate or reset an owner', async () => {
    await newUser('admin2', ['ADMIN']);
    const admin = await signIn('admin2', 'first-admin2-pass');
    await cmd().execute(
      changeOwnPassword,
      { currentPassword: 'first-admin2-pass', newPassword: 'admin two password' },
      admin,
    );
    const a = await signIn('admin2', 'admin two password');
    const ownerRow = await userRow(owner().user.username);
    const worker = await userRow(fx.actors.worker.user.username);

    await expect(newUser('sneaky-owner', ['OWNER'], a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cmd().execute(
        setUserRoles,
        { userId: worker.id, expectedVersion: worker.version, roles: ['OWNER'] },
        a,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cmd().execute(
        setUserRoles,
        { userId: ownerRow.id, expectedVersion: ownerRow.version, roles: ['WORKER'] },
        a,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cmd().execute(deactivateUser, { userId: ownerRow.id, expectedVersion: ownerRow.version }, a),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cmd().execute(
        resetUserPassword,
        {
          userId: ownerRow.id,
          expectedVersion: ownerRow.version,
          temporaryPassword: 'take the business',
        },
        a,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // …but may manage everyone else.
    const changed = await cmd().execute(
      setUserRoles,
      { userId: worker.id, expectedVersion: worker.version, roles: ['SUPERVISOR'] },
      a,
    );
    expect(changed.roles).toEqual(['SUPERVISOR']);
  });

  it('the company always keeps an active owner', async () => {
    const ownerRow = await userRow(owner().user.username);
    // Defence in depth: an actor claiming OWNER who is not the recorded owner.
    const impostor: AuthenticatedActor = {
      ...fx.actors.accountant,
      user: {
        ...fx.actors.accountant.user,
        roles: ['OWNER'],
        permissions: owner().user.permissions,
      },
    };
    await expect(
      cmd().execute(
        deactivateUser,
        { userId: ownerRow.id, expectedVersion: ownerRow.version },
        impostor,
      ),
    ).rejects.toMatchObject({ rule: 'LAST_OWNER' });
    await expect(
      cmd().execute(
        setUserRoles,
        { userId: ownerRow.id, expectedVersion: ownerRow.version, roles: ['ADMIN'] },
        impostor,
      ),
    ).rejects.toMatchObject({ rule: 'LAST_OWNER' });
  });

  it('only administrators manage users, and the AI never can', async () => {
    await expect(
      env.services.queries.execute(listUsers, {}, fx.actors.accountant),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(newUser('by-accountant', ['WORKER'], fx.actors.accountant)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(newUser('by-ai', ['WORKER'], asAiAgent(owner()))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      env.services.queries.execute(listUsers, {}, asAiAgent(owner())),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('deactivation, password reset and changing your own password', () => {
  it('deactivating ends sessions and stops sign-in; reactivating restores it', async () => {
    await newUser('leaver', ['WORKER']);
    const s = await signIn('leaver', 'first-leaver-pass');
    const row = await userRow('leaver');
    await cmd().execute(deactivateUser, { userId: row.id, expectedVersion: row.version }, owner());
    expect(
      await resolveSession(env.services.db, 'irrelevant-token-value-xx', clock.now()),
    ).toBeNull();
    const sessions = await env.ownerDb
      .selectFrom('identity.sessions')
      .select('revokedAt')
      .where('userId', '=', s.user.id)
      .execute();
    expect(sessions.every((x) => x.revokedAt !== null)).toBe(true);
    await expect(signIn('leaver', 'first-leaver-pass')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const disabled = await userRow('leaver');
    expect(disabled.status).toBe('DISABLED');
    await cmd().execute(
      reactivateUser,
      { userId: disabled.id, expectedVersion: disabled.version },
      owner(),
    );
    await expect(signIn('leaver', 'first-leaver-pass')).resolves.toBeDefined();
  });

  it('a reset ends sessions, replaces the password and forces a change', async () => {
    await newUser('forgetful', ['WORKER']);
    const first = await signIn('forgetful', 'first-forgetful-pass');
    await cmd().execute(
      changeOwnPassword,
      { currentPassword: 'first-forgetful-pass', newPassword: 'i will forget this' },
      first,
    );
    const row = await userRow('forgetful');
    await cmd().execute(
      resetUserPassword,
      { userId: row.id, expectedVersion: row.version, temporaryPassword: 'temporary for you' },
      owner(),
    );
    await expect(signIn('forgetful', 'i will forget this')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    const s = await signIn('forgetful', 'temporary for you');
    expect(s.user.mustChangePassword).toBe(true);
  });

  it('changing your own password checks the current one and ends your other sessions only', async () => {
    await newUser('careful', ['WORKER']);
    const a = await signIn('careful', 'first-careful-pass');
    const b = await signIn('careful', 'first-careful-pass');
    const wrong = { currentPassword: 'not it', newPassword: 'a new long password' };
    await expect(cmd().execute(changeOwnPassword, wrong, a)).rejects.toMatchObject({
      rule: 'CURRENT_PASSWORD_WRONG',
    });
    await expect(
      cmd().execute(
        changeOwnPassword,
        { currentPassword: 'first-careful-pass', newPassword: 'first-careful-pass' },
        a,
      ),
    ).rejects.toMatchObject({ rule: 'PASSWORD_UNCHANGED' });
    await expect(
      cmd().execute(
        changeOwnPassword,
        { currentPassword: 'first-careful-pass', newPassword: 'careful-and-long' },
        a,
      ),
    ).rejects.toMatchObject({ rule: 'PASSWORD_CONTAINS_USERNAME' });
    await expect(
      cmd().execute(
        changeOwnPassword,
        { currentPassword: 'first-careful-pass', newPassword: 'short' },
        a,
      ),
    ).rejects.toBeInstanceOf(Error);

    await cmd().execute(
      changeOwnPassword,
      { currentPassword: 'first-careful-pass', newPassword: 'a sensible passphrase' },
      a,
    );
    const sessions = await env.ownerDb
      .selectFrom('identity.sessions')
      .select(['id', 'revokedAt'])
      .where('userId', '=', a.user.id)
      .execute();
    expect(sessions.find((x) => x.id === a.user.sessionId)?.revokedAt).toBeNull();
    expect(sessions.find((x) => x.id === b.user.sessionId)?.revokedAt).not.toBeNull();
  });
});

describe('failed sign-ins: audit and backoff', () => {
  it('records every attempt and audits refusals of known users', async () => {
    await expect(signIn(owner().user.username, 'wrong password')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    const attempts = await env.ownerDb
      .selectFrom('identity.loginAttempts')
      .select(['username', 'outcome', 'ip', 'userId'])
      .where('username', '=', owner().user.username)
      .execute();
    expect(attempts).toContainEqual({
      username: owner().user.username,
      outcome: 'BAD_CREDENTIALS',
      ip: '10.0.0.7',
      userId: owner().user.id,
    });
    const audit = await env.ownerDb
      .selectFrom('audit.events')
      .select(['command', 'actorUserId', 'metadata'])
      .where('entityId', '=', owner().user.id)
      .where('command', '=', 'identity.session.refused')
      .execute();
    expect(audit[0]).toMatchObject({ actorUserId: null, metadata: { outcome: 'BAD_CREDENTIALS' } });
    expect((await userRow(owner().user.username)).failedSignInsLast24h).toBeGreaterThan(0);
  });

  it('after five failures the next attempt waits — even with the right password — then recovers', async () => {
    await newUser('target', ['WORKER']);
    for (let i = 0; i < 5; i++) {
      await expect(signIn('target', `guess ${i}`)).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
    await expect(signIn('target', 'first-target-pass')).rejects.toBeInstanceOf(
      TooManyAttemptsError,
    );
    clock.advance(31_000);
    await expect(signIn('target', 'first-target-pass')).resolves.toBeDefined();
  });

  it('treats unknown usernames exactly like real ones (no enumeration)', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(signIn('nobody-here', `guess ${i}`)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    }
    const err = await signIn('nobody-here', 'guess 6').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyAttemptsError);
    expect((err as TooManyAttemptsError).message).toMatch(/Try again in 1 minute/);
    expect(err).not.toBeInstanceOf(BusinessRuleError);
  });

  it('shows each user their last sign-in', async () => {
    expect((await userRow('target')).lastSignInAt).not.toBeNull();
    expect((await userRow(fx.actors.worker.user.username)).lastSignInAt).toBeNull();
    expect(TEST_PASSWORD).toBeTruthy();
  });
});

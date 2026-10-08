import {
  ChangePasswordRequest,
  CreateUserRequest,
  PERMISSIONS,
  ResetPasswordRequest,
  SetUserRolesRequest,
  UserStatusRequest,
  type RoleCode,
  type UserDto,
} from '@factory-erp/contracts';
import type { z } from 'zod';
import type { DbTransaction } from '../../db/database';
import type { AuthenticatedActor } from '../../platform/actor';
import { defineCommand, type CommandContext, type CommandOutcome } from '../../platform/commands';
import {
  BusinessRuleError,
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { hashPassword, verifyPassword } from './password';
import { loadUser } from './user-dto';

/**
 * User administration (Slice 0): the minimum a factory needs to run without a developer.
 * Rules that keep a company from locking itself out, or anyone from promoting themselves:
 *  - nobody changes their own roles, deactivates themselves or resets their own password here
 *    (they use "Change password");
 *  - only an OWNER may create, change, deactivate or reset an OWNER;
 *  - the company always keeps at least one active OWNER.
 * All of it is FORBIDDEN to the AI copilot, and every change is audited (never a password).
 */

/** Lock a user of this company and check the caller saw its latest version. */
async function lockUser(
  tx: DbTransaction,
  companyId: string,
  userId: string,
  expectedVersion: number,
  now: Date,
): Promise<UserDto> {
  const locked = await tx
    .selectFrom('identity.users as u')
    .select(['u.id', 'u.version'])
    .where('u.id', '=', userId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('identity.userRoles as m')
          .select('m.userId')
          .whereRef('m.userId', '=', 'u.id')
          .where('m.companyId', '=', companyId),
      ),
    )
    .forUpdate('u')
    .executeTakeFirst();
  if (!locked) throw new NotFoundError('User');
  if (locked.version !== expectedVersion) throw new VersionConflictError('User');
  return loadUser(tx, companyId, userId, now);
}

const isOwner = (actor: AuthenticatedActor) => actor.user.roles.includes('OWNER');

function assertNotSelf(actor: AuthenticatedActor, target: UserDto, what: string): void {
  if (target.id === actor.user.id) {
    throw new BusinessRuleError(
      'SELF_ADMINISTRATION',
      `You cannot ${what} for your own account; ask another administrator`,
    );
  }
}

function assertMayManageOwners(actor: AuthenticatedActor, ...roleSets: readonly RoleCode[][]) {
  if (!isOwner(actor) && roleSets.some((roles) => roles.includes('OWNER'))) {
    throw new ForbiddenError('only an owner can manage owners');
  }
}

/** Refuse a change that would leave the company without an active owner. */
async function assertOwnerRemains(tx: DbTransaction, companyId: string, losing: UserDto) {
  if (losing.status !== 'ACTIVE' || !losing.roles.includes('OWNER')) return;
  const others = await tx
    .selectFrom('identity.userRoles as ur')
    .innerJoin('identity.users as u', 'u.id', 'ur.userId')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('ur.companyId', '=', companyId)
    .where('ur.roleCode', '=', 'OWNER')
    .where('u.status', '=', 'ACTIVE')
    .where('u.id', '<>', losing.id)
    .executeTakeFirstOrThrow();
  if (Number(others.n) === 0) {
    throw new BusinessRuleError('LAST_OWNER', 'The company must keep at least one active owner');
  }
}

async function revokeSessions(tx: DbTransaction, userId: string, now: Date, keep?: string) {
  let q = tx
    .updateTable('identity.sessions')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null);
  if (keep) q = q.where('id', '<>', keep);
  await q.execute();
}

const auditView = (u: UserDto) => ({
  username: u.username,
  displayName: u.displayName,
  status: u.status,
  roles: u.roles,
  mustChangePassword: u.mustChangePassword,
});

export const createUser = defineCommand({
  name: 'identity.user.create',
  description:
    'Create a sign-in with roles and a first password the user must change at first sign-in.',
  input: CreateUserRequest,
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    assertMayManageOwners(actor, input.roles);
    const taken = await tx
      .selectFrom('identity.users')
      .select('id')
      .where('username', '=', input.username)
      .executeTakeFirst();
    if (taken) throw new DuplicateError(`The username ${input.username} is already taken`);

    const id = uuidv7(now.getTime());
    await tx
      .insertInto('identity.users')
      .values({
        id,
        username: input.username,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.initialPassword),
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await tx
      .insertInto('identity.userRoles')
      .values(input.roles.map((roleCode) => ({ userId: id, roleCode, companyId })))
      .execute();
    const user = await loadUser(tx, companyId, id, now);
    return {
      result: user,
      audit: [{ entityType: 'identity.user', entityId: id, after: auditView(user) }],
    };
  },
});

export const setUserRoles = defineCommand({
  name: 'identity.user.setRoles',
  description: "Replace a user's roles in this company. Takes effect on their next request.",
  input: SetUserRolesRequest,
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockUser(tx, companyId, input.userId, input.expectedVersion, now);
    assertNotSelf(actor, before, 'change roles');
    assertMayManageOwners(actor, before.roles, input.roles);
    if (!input.roles.includes('OWNER')) await assertOwnerRemains(tx, companyId, before);

    await tx
      .deleteFrom('identity.userRoles')
      .where('userId', '=', before.id)
      .where('companyId', '=', companyId)
      .execute();
    await tx
      .insertInto('identity.userRoles')
      .values(input.roles.map((roleCode) => ({ userId: before.id, roleCode, companyId })))
      .execute();
    await tx
      .updateTable('identity.users')
      .set({ version: before.version + 1, updatedAt: now })
      .where('id', '=', before.id)
      .execute();
    const after = await loadUser(tx, companyId, before.id, now);
    return {
      result: after,
      audit: [
        {
          entityType: 'identity.user',
          entityId: before.id,
          before: { roles: before.roles },
          after: { roles: after.roles },
        },
      ],
    };
  },
});

async function setUserStatus(
  { tx, actor, companyId, now }: CommandContext,
  input: z.output<typeof UserStatusRequest>,
  target: 'ACTIVE' | 'DISABLED',
): Promise<CommandOutcome<UserDto>> {
  const disabling = target === 'DISABLED';
  const before = await lockUser(tx, companyId, input.userId, input.expectedVersion, now);
  assertNotSelf(actor, before, disabling ? 'deactivate sign-in' : 'reactivate sign-in');
  assertMayManageOwners(actor, before.roles);
  if (before.status === target) {
    throw new BusinessRuleError(
      disabling ? 'USER_ALREADY_DISABLED' : 'USER_ALREADY_ACTIVE',
      `${before.username} is already ${disabling ? 'deactivated' : 'active'}`,
    );
  }
  if (disabling) {
    await assertOwnerRemains(tx, companyId, before);
    await revokeSessions(tx, before.id, now);
  }
  await tx
    .updateTable('identity.users')
    .set({ status: target, version: before.version + 1, updatedAt: now })
    .where('id', '=', before.id)
    .execute();
  const after = await loadUser(tx, companyId, before.id, now);
  return {
    result: after,
    audit: [
      {
        entityType: 'identity.user',
        entityId: before.id,
        before: { status: before.status },
        after: { status: after.status },
      },
    ],
  };
}

export const deactivateUser = defineCommand({
  name: 'identity.user.deactivate',
  description: 'Stop a user signing in and end their open sessions. Their history is kept.',
  input: UserStatusRequest,
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  handler: (ctx, input) => setUserStatus(ctx, input, 'DISABLED'),
});

export const reactivateUser = defineCommand({
  name: 'identity.user.reactivate',
  description: 'Let a deactivated user sign in again.',
  input: UserStatusRequest,
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  handler: (ctx, input) => setUserStatus(ctx, input, 'ACTIVE'),
});

export const resetUserPassword = defineCommand({
  name: 'identity.user.resetPassword',
  description:
    'Set a temporary password for someone who forgot theirs. Their sessions end and they must choose a new password at next sign-in.',
  input: ResetPasswordRequest,
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockUser(tx, companyId, input.userId, input.expectedVersion, now);
    assertNotSelf(actor, before, 'reset the password (use Change password)');
    assertMayManageOwners(actor, before.roles);
    await tx
      .updateTable('identity.users')
      .set({
        passwordHash: await hashPassword(input.temporaryPassword),
        mustChangePassword: true,
        version: before.version + 1,
        updatedAt: now,
      })
      .where('id', '=', before.id)
      .execute();
    await revokeSessions(tx, before.id, now);
    const after = await loadUser(tx, companyId, before.id, now);
    return {
      result: after,
      audit: [
        {
          entityType: 'identity.user',
          entityId: before.id,
          metadata: { passwordReset: true, sessionsRevoked: true },
        },
      ],
    };
  },
});

export const changeOwnPassword = defineCommand({
  name: 'identity.password.change',
  description: 'Change your own password. Your other sessions end; this one stays signed in.',
  input: ChangePasswordRequest,
  permission: PERMISSIONS.accountSelf,
  ai: { tier: 'FORBIDDEN' },
  allowDuringPasswordChange: true,
  handler: async ({ tx, actor, companyId, now }, input) => {
    const user = await tx
      .selectFrom('identity.users')
      .select(['id', 'username', 'passwordHash', 'version'])
      .where('id', '=', actor.user.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new BusinessRuleError(
        'CURRENT_PASSWORD_WRONG',
        'Your current password is not correct',
        [{ path: 'currentPassword', message: 'Not your current password' }],
      );
    }
    if (input.newPassword === input.currentPassword) {
      throw new BusinessRuleError(
        'PASSWORD_UNCHANGED',
        'Choose a password different from the current one',
        [{ path: 'newPassword', message: 'Same as the current password' }],
      );
    }
    if (input.newPassword.toLowerCase().includes(user.username)) {
      throw new BusinessRuleError(
        'PASSWORD_CONTAINS_USERNAME',
        'Do not use your username in your password',
        [{ path: 'newPassword', message: 'Contains your username' }],
      );
    }
    await tx
      .updateTable('identity.users')
      .set({
        passwordHash: await hashPassword(input.newPassword),
        mustChangePassword: false,
        passwordChangedAt: now,
        version: user.version + 1,
        updatedAt: now,
      })
      .where('id', '=', user.id)
      .execute();
    await revokeSessions(tx, user.id, now, actor.user.sessionId);
    return {
      result: { changed: true as const },
      audit: [
        {
          entityType: 'identity.user',
          entityId: user.id,
          metadata: { passwordChanged: true, otherSessionsRevoked: true, companyId },
        },
      ],
    };
  },
});

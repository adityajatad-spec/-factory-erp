import { z } from 'zod';
import { Uuid } from './common';
import { restricted } from './data-class';
import { ROLE_CODES, type RoleCode } from './permissions';

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,64}$/, '3–64 lower-case letters, digits, dots, hyphens or underscores');

/**
 * A new password. Length is what matters (NIST SP 800-63B); no composition rules. Marked
 * RESTRICTED: never logged, never hashed into idempotency records, never sent to a model.
 */
export const NewPassword = restricted(
  z.string().min(10, 'Use at least 10 characters').max(200, 'Use at most 200 characters'),
);

const RoleList = z
  .array(z.enum(ROLE_CODES))
  .min(1, 'Give at least one role')
  .max(ROLE_CODES.length)
  .refine((r) => new Set(r).size === r.length, 'Each role only once');

/**
 * Create a sign-in for this company. The administrator sets the first password (or lets the
 * screen generate one) and shares it; the user must choose their own at first sign-in.
 */
export const CreateUserRequest = z.object({
  username: Username,
  displayName: z.string().trim().min(1).max(100),
  roles: RoleList,
  initialPassword: NewPassword,
});
export type CreateUserRequest = z.input<typeof CreateUserRequest>;

export const SetUserRolesRequest = z.object({
  userId: Uuid,
  expectedVersion: z.number().int().positive(),
  roles: RoleList,
});
export type SetUserRolesRequest = z.input<typeof SetUserRolesRequest>;

export const UserStatusRequest = z.object({
  userId: Uuid,
  expectedVersion: z.number().int().positive(),
});
export type UserStatusRequest = z.input<typeof UserStatusRequest>;

/** An administrator sets a temporary password; the user must replace it at next sign-in. */
export const ResetPasswordRequest = z.object({
  userId: Uuid,
  expectedVersion: z.number().int().positive(),
  temporaryPassword: NewPassword,
});
export type ResetPasswordRequest = z.input<typeof ResetPasswordRequest>;

/** Change your own password (requires the current one). */
export const ChangePasswordRequest = z.object({
  currentPassword: restricted(z.string().min(1).max(256)),
  newPassword: NewPassword,
});
export type ChangePasswordRequest = z.input<typeof ChangePasswordRequest>;

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  roles: RoleCode[];
  mustChangePassword: boolean;
  lastSignInAt: string | null;
  failedSignInsLast24h: number;
  version: number;
}

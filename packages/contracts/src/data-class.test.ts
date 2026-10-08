import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { LoginRequest } from './auth';
import {
  maxDataClass,
  omitRestricted,
  restricted,
  restrictedPaths,
  withinDataClass,
} from './data-class';
import { ChangePasswordRequest, CreateUserRequest, ResetPasswordRequest } from './users';

describe('data classes', () => {
  it('orders classes and takes the high-water mark', () => {
    expect(maxDataClass('PUBLIC', 'CONFIDENTIAL', 'INTERNAL')).toBe('CONFIDENTIAL');
    expect(maxDataClass()).toBe('PUBLIC');
    expect(withinDataClass('INTERNAL', 'CONFIDENTIAL')).toBe(true);
    expect(withinDataClass('RESTRICTED', 'CONFIDENTIAL')).toBe(false);
  });
});

describe('RESTRICTED field markers', () => {
  it('are declared on every credential in the contracts', () => {
    expect(restrictedPaths(LoginRequest)).toEqual(['password']);
    expect(restrictedPaths(CreateUserRequest)).toEqual(['initialPassword']);
    expect(restrictedPaths(ResetPasswordRequest)).toEqual(['temporaryPassword']);
    expect(restrictedPaths(ChangePasswordRequest).sort()).toEqual([
      'currentPassword',
      'newPassword',
    ]);
  });

  it('are found through wrappers, nesting and arrays', () => {
    const pin = restricted(z.string());
    const schema = z.object({
      a: z.string(),
      b: pin.optional(),
      c: z.array(z.object({ d: pin, e: z.number() })),
      f: z.object({ g: pin.nullable().transform((v) => v ?? '') }),
    });
    expect(restrictedPaths(schema)).toEqual(['b', 'c[].d', 'f.g']);
    expect(
      omitRestricted(schema, { a: 'x', b: 's', c: [{ d: 's', e: 1 }], f: { g: 's' } }),
    ).toEqual({ a: 'x', c: [{ e: 1 }], f: {} });
  });

  it('removes secrets from a parsed request without touching anything else', () => {
    const input = CreateUserRequest.parse({
      username: 'Ravi',
      displayName: 'Ravi',
      roles: ['ACCOUNTANT'],
      initialPassword: 'correct horse battery',
    });
    expect(omitRestricted(CreateUserRequest, input)).toEqual({
      username: 'ravi',
      displayName: 'Ravi',
      roles: ['ACCOUNTANT'],
    });
  });
});

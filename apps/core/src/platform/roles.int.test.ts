import { ALL_PERMISSIONS, ROLE_CODES } from '@factory-erp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { syncRoles } from '../seed/seed';
import { DEFAULT_ROLES } from './roles';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
  await syncRoles(env.services);
});
afterAll(async () => env.destroy());

describe('role / permission matrix', () => {
  it('stores exactly the coded role definitions', async () => {
    const rows = await env.services.db.selectFrom('identity.rolePermissions').selectAll().execute();
    for (const role of ROLE_CODES) {
      const stored = rows
        .filter((r) => r.roleCode === role)
        .map((r) => r.permission)
        .sort();
      expect(stored, role).toEqual([...DEFAULT_ROLES[role].permissions].sort());
    }
  });

  it('only stores permission codes that exist in the code registry', async () => {
    const rows = await env.services.db
      .selectFrom('identity.rolePermissions')
      .select('permission')
      .distinct()
      .execute();
    for (const r of rows) expect(ALL_PERMISSIONS).toContain(r.permission);
  });

  // A reviewable snapshot: any change to who-can-do-what shows up as a diff in code review.
  it('matches the reviewed permission matrix', () => {
    const matrix = Object.fromEntries(
      ROLE_CODES.map((r) => [r, [...DEFAULT_ROLES[r].permissions].sort()]),
    );
    expect(matrix).toMatchSnapshot();
  });

  it('is idempotent', async () => {
    await syncRoles(env.services);
    const count = await env.services.db
      .selectFrom('identity.rolePermissions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const expected = ROLE_CODES.reduce((n, r) => n + DEFAULT_ROLES[r].permissions.length, 0);
    expect(Number(count.n)).toBe(expected);
  });
});

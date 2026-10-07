import { cp, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { defaultMigrationsDir, migrate, MigrationError } from './migrate';

let env: TestEnv;
let dir: string;

beforeAll(async () => {
  env = await createTestEnv(); // already fully migrated from the template
  dir = await mkdtemp(path.join(tmpdir(), 'ferp-migrations-'));
  await cp(defaultMigrationsDir(), dir, { recursive: true });
});
afterAll(async () => {
  await env.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('is a no-op on an up-to-date database', async () => {
    expect((await migrate(env.databaseUrl, { migrationsDir: dir })).applied).toEqual([]);
  });

  it('applies new migrations in order, transactionally', async () => {
    await writeFile(
      path.join(dir, '9001_test_extra.sql'),
      'create table system.test_extra (id int primary key);',
    );
    expect((await migrate(env.databaseUrl, { migrationsDir: dir })).applied).toEqual([
      '9001_test_extra',
    ]);
  });

  it('rolls back a failing migration completely', async () => {
    await writeFile(
      path.join(dir, '9002_broken.sql'),
      'create table system.half_done (id int); select 1/0;',
    );
    await expect(migrate(env.databaseUrl, { migrationsDir: dir })).rejects.toBeInstanceOf(
      MigrationError,
    );
    const { rows } = await import('pg').then(async ({ default: pg }) => {
      const c = new pg.Client({ connectionString: env.databaseUrl });
      await c.connect();
      try {
        return await c.query("select to_regclass('system.half_done') as t");
      } finally {
        await c.end();
      }
    });
    expect(rows[0]).toEqual({ t: null });
    await rm(path.join(dir, '9002_broken.sql'));
  });

  it('refuses to run when an applied migration was edited', async () => {
    await appendFile(
      path.join(dir, '0001_platform_identity_audit.sql'),
      '\n-- edited after release\n',
    );
    await expect(migrate(env.databaseUrl, { migrationsDir: dir })).rejects.toThrow(
      /modified after being applied/,
    );
  });
});

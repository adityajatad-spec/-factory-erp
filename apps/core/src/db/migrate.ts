import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { Logger } from '../logger';
import { findRepoPath } from '../platform/paths';

/**
 * Forward-only SQL migrations (db/migrations/NNNN_name.sql).
 *
 * - Each file runs in its own transaction (PostgreSQL DDL is transactional, so a failed
 *   migration leaves no partial state).
 * - Applied files are checksummed; editing an applied migration is an error.
 * - A session advisory lock prevents two processes migrating concurrently.
 */

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 7_243_115_001;

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function defaultMigrationsDir(): string {
  return findRepoPath('db/migrations');
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const result: MigrationFile[] = [];
  for (const file of files) {
    const m = FILE_PATTERN.exec(file);
    if (!m?.[1] || !m[2])
      throw new MigrationError(`Bad migration file name: ${file} (expected NNNN_name.sql)`);
    if (seen.has(m[1])) throw new MigrationError(`Duplicate migration version ${m[1]}`);
    seen.add(m[1]);
    const sql = await readFile(path.join(dir, file), 'utf8');
    result.push({
      version: m[1],
      name: m[2],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return result;
}

export async function migrate(
  databaseUrl: string,
  opts: { migrationsDir?: string; logger?: Pick<Logger, 'info'> } = {},
): Promise<{ applied: string[] }> {
  const migrations = await loadMigrations(opts.migrationsDir ?? defaultMigrationsDir());
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'factory-erp-migrate',
  });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create schema if not exists system;
      create table if not exists system.schema_migrations (
        version    text primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      );`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'select version, checksum from system.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of migrations) {
      const existing = done.get(m.version);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new MigrationError(
            `Migration ${m.version}_${m.name} was modified after being applied. Write a new migration instead.`,
          );
        }
        continue;
      }
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query(
          'insert into system.schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('commit');
      } catch (cause) {
        await client.query('rollback');
        throw new MigrationError(
          `Migration ${m.version}_${m.name} failed: ${(cause as Error).message}`,
          { cause },
        );
      }
      applied.push(`${m.version}_${m.name}`);
      opts.logger?.info({ migration: `${m.version}_${m.name}` }, 'migration applied');
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return { applied };
}

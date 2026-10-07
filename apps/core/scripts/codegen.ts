/**
 * Regenerate src/db/schema.generated.ts from the migrated development database.
 * The database schema (db/migrations) is the source of truth; never edit the output by hand.
 * Pass --verify to fail if the committed file is out of date (used in CI).
 */
import { spawnSync } from 'node:child_process';

const args = [
  'exec',
  'kysely-codegen',
  '--dialect=postgres',
  '--camel-case',
  '--date-parser=string',
  '--numeric-parser=string',
  '--exclude-pattern=system.schema_migrations',
  '--out-file=src/db/schema.generated.ts',
  ...process.argv.slice(2),
];

const result = spawnSync('pnpm', args, { stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;

import { CamelCasePlugin, Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.generated';

// Business dates (DATE columns) stay ISO strings. Converting them to JS Date objects would
// attach a timezone and shift invoice dates around midnight IST.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
// NUMERIC and INT8 are already returned as strings by node-postgres — never as JS numbers.

export type Database = Kysely<DB>;
export type DbTransaction = Transaction<DB>;
export type DbExecutor = Database | DbTransaction;

export function createDatabase(
  databaseUrl: string,
  opts: { maxConnections?: number } = {},
): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.maxConnections ?? 10,
    application_name: 'factory-erp-core',
  });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // camelCase in TypeScript, snake_case in SQL. JSON column contents are left untouched.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}

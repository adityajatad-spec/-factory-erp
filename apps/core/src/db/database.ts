import {
  CamelCasePlugin,
  Kysely,
  PostgresDialect,
  type PostgresPool,
  type Transaction,
} from 'kysely';
import pg from 'pg';
import { DatabaseUnavailableError } from '../platform/errors';
import type { DB } from './schema.generated';

// Business dates (DATE columns) stay ISO strings. Converting them to JS Date objects would
// attach a timezone and shift invoice dates around midnight IST.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
// NUMERIC and INT8 are already returned as strings by node-postgres — never as JS numbers.

export type Database = Kysely<DB>;
export type DbTransaction = Transaction<DB>;
export type DbExecutor = Database | DbTransaction;

/** How long a caller may wait for a pooled connection unless configured otherwise. */
export const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * The driver's errors when `connectionTimeoutMillis` runs out, matched exactly: pg-pool's for
 * waiting on a busy pool and for opening a new connection (both pinned by tests), and pg's
 * own client timer for the latter, which runs with the same delay but is registered after
 * the pool's and so normally loses the race (not reproducible in a test).
 */
const POOL_TIMEOUT_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'timeout expired',
]);

/**
 * The connection pool. Getting a connection is bounded by `acquireTimeoutMs` (pg-pool's
 * `connectionTimeoutMillis`): both the wait for a free connection when all are busy and the
 * opening of a new one. Past it the caller gets DatabaseUnavailableError (503), never an
 * indefinite wait. It bounds acquisition only: a connection once held — a transaction, a
 * query — is untouched (statements are bounded separately by statement_timeout, per query).
 */
export function createDatabase(
  databaseUrl: string,
  opts: { maxConnections?: number; acquireTimeoutMs?: number } = {},
): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.maxConnections ?? 10,
    connectionTimeoutMillis: opts.acquireTimeoutMs ?? DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
    application_name: 'factory-erp-core',
  });
  // The pool as Kysely sees it: pg-pool's own pool, with its timeout errors made typed.
  const bounded: PostgresPool = {
    Client: pg.Client,
    options: pool.options,
    connect: () =>
      pool.connect().catch((err: unknown) => {
        throw err instanceof Error && POOL_TIMEOUT_MESSAGES.has(err.message)
          ? new DatabaseUnavailableError({ cause: err })
          : err;
      }),
    end: () => pool.end(),
  };
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: bounded }),
    // camelCase in TypeScript, snake_case in SQL. JSON column contents are left untouched.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}

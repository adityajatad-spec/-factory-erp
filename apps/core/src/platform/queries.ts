import type { DataClass, Permission } from '@factory-erp/contracts';
import type { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/database';
import type { Actor, AuthenticatedActor } from './actor';
import type { Clock } from './clock';
import { requireAuthenticated } from './commands';
import {
  ForbiddenError,
  PasswordChangeRequiredError,
  QueryTimeoutError,
  ValidationError,
} from './errors';
import { zodIssues } from './validation';

export interface QueryContext {
  /** A read-only, repeatable-read transaction: every read in one query sees one snapshot. */
  db: Database;
  actor: AuthenticatedActor;
  companyId: string;
  now: Date;
  /** For optional, separately-permissioned fields (e.g. balances on a party). */
  can: (permission: Permission) => boolean;
}

export interface QueryDefinition<S extends z.ZodType, R> {
  name: string;
  description: string;
  input: S;
  permission: Permission;
  /** READ: the AI copilot may call it (as the user). FORBIDDEN: never exposed to AI. */
  ai: { tier: 'READ' | 'FORBIDDEN' };
  /**
   * How sensitive the RESULT is (docs/ROADMAP.md §5.5). The AI gateway will route on it:
   * a session that has seen CONFIDENTIAL results only talks to models allowed CONFIDENTIAL.
   */
  dataClass: DataClass;
  /** Sample inputs: future tool descriptions and evaluation cases (validated by a test). */
  examples?: readonly { description: string; input: NoInfer<z.input<S>> }[];
  handler(ctx: QueryContext, input: z.output<S>): Promise<R>;
}

/** Any query, for registries (src/registry.ts). */
export type AnyQuery = QueryDefinition<z.ZodType, unknown>;

export function defineQuery<S extends z.ZodType, R>(
  def: QueryDefinition<S, R>,
): QueryDefinition<S, R> {
  return def;
}

export interface QueryOptions {
  /**
   * Upper bound for each SQL statement of this query, enforced by PostgreSQL itself
   * (`statement_timeout`, local to the query's transaction): a statement running longer is
   * cancelled by the server, the transaction rolls back and the connection returns to the pool.
   * Callers with their own deadline (the AI copilot) pass what is left of it.
   */
  timeoutMs?: number;
}

/** PostgreSQL's SQLSTATE for a statement cancelled by statement_timeout (or a cancel request). */
const QUERY_CANCELED = '57014';

export class QueryBus {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(deps: { db: Database; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  async execute<S extends z.ZodType, R>(
    query: QueryDefinition<S, R>,
    rawInput: unknown,
    actor: Actor,
    opts: QueryOptions = {},
  ): Promise<R> {
    const parsed = query.input.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError(zodIssues(parsed.error));

    const authed = requireAuthenticated(actor);
    const permissions = authed.user.permissions;
    if (authed.user.mustChangePassword) throw new PasswordChangeRequiredError();
    if (!permissions.has(query.permission)) throw new ForbiddenError(query.permission);
    if (authed.actorKind === 'ai_agent' && query.ai.tier !== 'READ') {
      throw new ForbiddenError(`${query.name} is not available to the AI copilot`);
    }

    // One consistent snapshot per query: a report that reads several tables can never combine
    // figures from two different moments. READ ONLY also makes a query that tries to write
    // fail at once (the architecture test forbids it statically too).
    const companyId = authed.user.companyId;
    const now = this.#clock.now();
    const timeoutMs =
      opts.timeoutMs === undefined ? undefined : Math.max(1, Math.floor(opts.timeoutMs));
    try {
      return await this.#db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (tx) => {
          if (timeoutMs !== undefined) {
            // set_config(..., true) = SET LOCAL: ends with this transaction, never leaks to the
            // pooled connection's next user.
            await sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`.execute(
              tx,
            );
          }
          return query.handler(
            { db: tx, actor: authed, companyId, now, can: (p) => permissions.has(p) },
            parsed.data,
          );
        });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === QUERY_CANCELED)
        throw new QueryTimeoutError();
      throw err;
    }
  }
}

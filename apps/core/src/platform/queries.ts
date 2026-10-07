import type { Permission } from '@factory-erp/contracts';
import type { z } from 'zod';
import type { Database } from '../db/database';
import type { Actor, AuthenticatedActor } from './actor';
import type { Clock } from './clock';
import { requireAuthenticated } from './commands';
import { ForbiddenError, ValidationError } from './errors';
import { zodIssues } from './validation';

export interface QueryContext {
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
  handler: (ctx: QueryContext, input: z.output<S>) => Promise<R>;
}

export function defineQuery<S extends z.ZodType, R>(
  def: QueryDefinition<S, R>,
): QueryDefinition<S, R> {
  return def;
}

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
  ): Promise<R> {
    const parsed = query.input.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError(zodIssues(parsed.error));

    const authed = requireAuthenticated(actor);
    const permissions = authed.user.permissions;
    if (!permissions.has(query.permission)) throw new ForbiddenError(query.permission);
    if (authed.actorKind === 'ai_agent' && query.ai.tier !== 'READ') {
      throw new ForbiddenError(`${query.name} is not available to the AI copilot`);
    }

    return query.handler(
      {
        db: this.#db,
        actor: authed,
        companyId: authed.user.companyId,
        now: this.#clock.now(),
        can: (p) => permissions.has(p),
      },
      parsed.data,
    );
  }
}

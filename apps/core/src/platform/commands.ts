import { omitRestricted, type Permission } from '@factory-erp/contracts';
import type { z } from 'zod';
import type { Database, DbTransaction } from '../db/database';
import type { Logger } from '../logger';
import type { Actor, AuthenticatedActor } from './actor';
import { writeAudit, type AuditRecord } from './audit';
import type { Clock } from './clock';
import { translateDbError } from './db-errors';
import {
  ForbiddenError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
  ValidationError,
} from './errors';
import { claimIdempotencyKey, storeIdempotentResponse } from './idempotency';
import { canonicalJson, sha256Hex } from './json';
import { enqueueOutbox, type OutboxRecord } from './outbox';
import { isPgError } from './safe-errors';
import { zodIssues } from './validation';

/**
 * How the future AI copilot may use a command (docs/ARCHITECTURE.md §G.2):
 * - DRAFT: the AI may execute it; it only creates drafts/proposals.
 * - CONFIRM: only a human can execute it (after reviewing an action card).
 * - FORBIDDEN: never available to the AI.
 */
export type CommandAiTier = 'DRAFT' | 'CONFIRM' | 'FORBIDDEN';

export interface CommandContext {
  tx: DbTransaction;
  actor: AuthenticatedActor;
  companyId: string;
  /** One timestamp for the whole command — every row it writes agrees on "now". */
  now: Date;
}

export interface CommandOutcome<R> {
  result: R;
  /** Every mutation must be audited — the type requires at least one record. */
  audit: readonly [AuditRecord, ...AuditRecord[]];
  outbox?: readonly OutboxRecord[];
}

export interface CommandDefinition<S extends z.ZodType, R> {
  /** Stable dotted name, e.g. "sales.invoice.issue". Recorded in audit events. */
  name: string;
  /** Plain-language description (becomes the AI tool description later). */
  description: string;
  input: S;
  permission: Permission;
  ai: { tier: CommandAiTier };
  /** Sample inputs: future tool descriptions and evaluation cases (validated by a test). */
  examples?: readonly { description: string; input: NoInfer<z.input<S>> }[];
  /** Runs even while the user must change their password (only the password change does). */
  allowDuringPasswordChange?: true;
  handler(ctx: CommandContext, input: z.output<S>): Promise<CommandOutcome<R>>;
}

/** Any command, for registries (src/registry.ts); executing one still goes through the bus. */
export type AnyCommand = CommandDefinition<z.ZodType, unknown>;

export function defineCommand<S extends z.ZodType, R>(
  def: CommandDefinition<S, R>,
): CommandDefinition<S, R> {
  return def;
}

export function requireAuthenticated(actor: Actor): AuthenticatedActor {
  if (!actor.user) throw new UnauthenticatedError();
  return actor as AuthenticatedActor;
}

export class CommandBus {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: { db: Database; clock: Clock; logger: Logger }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  /**
   * validate → authenticate → authorize → [idempotency → transaction → domain → audit →
   * outbox] → response. HTTP routes and (later) AI tools both call this; neither has a
   * privileged path around it.
   */
  async execute<S extends z.ZodType, R>(
    command: CommandDefinition<S, R>,
    rawInput: unknown,
    actor: Actor,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<R> {
    const started = performance.now();

    const parsed = command.input.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError(zodIssues(parsed.error));
    const input = parsed.data;

    const authed = requireAuthenticated(actor);
    if (authed.user.mustChangePassword && !command.allowDuringPasswordChange) {
      throw new PasswordChangeRequiredError();
    }
    if (!authed.user.permissions.has(command.permission))
      throw new ForbiddenError(command.permission);
    if (authed.actorKind === 'ai_agent' && command.ai.tier !== 'DRAFT') {
      throw new ForbiddenError(`${command.name} requires a human (AI tier ${command.ai.tier})`);
    }

    const now = this.#clock.now();
    const userId = authed.user.id;
    const companyId = authed.user.companyId;
    const key = opts.idempotencyKey;
    // RESTRICTED fields (passwords) never enter the stored request hash.
    const requestHash = key
      ? sha256Hex(
          canonicalJson({ command: command.name, input: omitRestricted(command.input, input) }),
        )
      : '';

    let outcome: { replayed: boolean; result: R };
    try {
      outcome = await this.#db.transaction().execute(async (tx) => {
        if (key) {
          const claim = await claimIdempotencyKey(tx, {
            userId,
            key,
            command: command.name,
            requestHash,
          });
          if (claim.kind === 'replay') return { replayed: true, result: claim.response as R };
        }

        const done = await command.handler({ tx, actor: authed, companyId, now }, input);
        await writeAudit(tx, done.audit, {
          actor: authed,
          command: command.name,
          companyId,
          occurredAt: now,
        });
        if (done.outbox?.length) await enqueueOutbox(tx, done.outbox, now, companyId);
        if (key) await storeIdempotentResponse(tx, { userId, key, response: done.result });
        return { replayed: false, result: done.result };
      });
    } catch (err) {
      const translated = translateDbError(err);
      if (translated !== err && isPgError(err)) {
        // The client gets a generic rule message; operators get the SQLSTATE and the table.
        this.#logger.warn(
          {
            command: command.name,
            requestId: authed.requestId,
            sqlState: err.code,
            table: err.table ?? null,
          },
          'command rejected by a database rule',
        );
      }
      throw translated;
    }

    this.#logger.info(
      {
        command: command.name,
        userId,
        actorKind: authed.actorKind,
        requestId: authed.requestId,
        replayed: outcome.replayed,
        durationMs: Math.round(performance.now() - started),
      },
      'command executed',
    );
    return outcome.result;
  }
}

import { sql, type Selectable } from 'kysely';
import type { Database, DbTransaction } from '../db/database';
import type { SystemOutboxEvents } from '../db/schema.generated';
import type { Logger } from '../logger';
import { systemActor } from './actor';
import { writeAudit } from './audit';
import type { Clock } from './clock';
import { BusinessRuleError, NotFoundError } from './errors';
import { uuidv7 } from './ids';
import { toJsonb } from './json';

export interface OutboxRecord {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export type OutboxEvent = Selectable<SystemOutboxEvents>;

/**
 * A side effect delivered at least once, so it must be idempotent. Work happens in two phases:
 *
 * - `prepare` (optional) does the slow part — rendering a PDF, calling a service — with no
 *   transaction open and no row locked, so it never blocks the business records it reads;
 * - `apply` is short: it re-checks the state under a lock and records the result. The event is
 *   marked DONE in the same transaction, so a crash in between simply retries.
 */
export interface OutboxHandler<P = unknown> {
  prepare?(ctx: { db: Database; event: OutboxEvent; now: Date }): Promise<P>;
  apply(ctx: { tx: DbTransaction; event: OutboxEvent; now: Date; prepared: P }): Promise<void>;
}

export function defineOutboxHandler<P>(handler: OutboxHandler<P>): OutboxHandler {
  return handler;
}

export async function enqueueOutbox(
  tx: DbTransaction,
  records: readonly OutboxRecord[],
  now: Date,
  companyId: string | null,
): Promise<void> {
  await tx
    .insertInto('system.outboxEvents')
    .values(
      records.map((r) => ({
        id: uuidv7(now.getTime()),
        companyId,
        occurredAt: now,
        availableAt: now,
        topic: r.topic,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        payload: toJsonb(r.payload),
      })),
    )
    .execute();
}

const LEASE_MS = 5 * 60_000;

/**
 * Polls system.outbox_events. Each event is claimed with a lease (available_at pushed into
 * the future, FOR UPDATE SKIP LOCKED), processed in its own transaction, then marked DONE.
 * A crashed worker's lease simply expires and the event is retried.
 */
export class OutboxDispatcher {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #handlers: Readonly<Record<string, OutboxHandler>>;
  readonly #pollMs: number;
  readonly #maxAttempts: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor(deps: {
    db: Database;
    clock: Clock;
    logger: Logger;
    handlers: Readonly<Record<string, OutboxHandler>>;
    pollMs?: number;
    maxAttempts?: number;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#handlers = deps.handlers;
    this.#pollMs = deps.pollMs ?? 1000;
    this.#maxAttempts = deps.maxAttempts ?? 8;
  }

  /** Process up to `limit` due events. Returns how many were attempted. */
  async runOnce(limit = 20): Promise<number> {
    let attempted = 0;
    while (attempted < limit) {
      const event = await this.#claim();
      if (!event) break;
      attempted++;
      await this.#process(event);
    }
    return attempted;
  }

  start(): void {
    this.#stopped = false;
    const tick = () => {
      if (this.#stopped) return;
      this.#running = this.runOnce()
        .then(() => undefined)
        .catch((err: unknown) => this.#logger.error({ err }, 'outbox poll failed'))
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(tick, this.#pollMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  async #claim(): Promise<OutboxEvent | undefined> {
    const now = this.#clock.now();
    return this.#db
      .updateTable('system.outboxEvents')
      .set({
        attempts: sql<number>`attempts + 1`,
        availableAt: new Date(now.getTime() + LEASE_MS),
      })
      .where('id', '=', (eb) =>
        eb
          .selectFrom('system.outboxEvents')
          .select('id')
          .where('status', '=', 'PENDING')
          .where('availableAt', '<=', now)
          .orderBy('occurredAt')
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async #process(event: OutboxEvent): Promise<void> {
    const handler = this.#handlers[event.topic];
    const now = this.#clock.now();
    try {
      if (!handler) throw new Error(`No outbox handler registered for topic "${event.topic}"`);
      const prepared = handler.prepare
        ? await handler.prepare({ db: this.#db, event, now })
        : undefined;
      await this.#db.transaction().execute(async (tx) => {
        await handler.apply({ tx, event, now, prepared });
        await tx
          .updateTable('system.outboxEvents')
          .set({ status: 'DONE', processedAt: now, lastError: null })
          .where('id', '=', event.id)
          .execute();
      });
      this.#logger.info(
        { topic: event.topic, eventId: event.id, attempt: event.attempts },
        'outbox event processed',
      );
    } catch (err) {
      const failed = event.attempts >= this.#maxAttempts;
      const backoffMs = Math.min(60_000 * 2 ** (event.attempts - 1), 60 * 60_000);
      const lastError = err instanceof Error ? err.message.slice(0, 2000) : String(err);
      await this.#db.transaction().execute(async (tx) => {
        await tx
          .updateTable('system.outboxEvents')
          .set({
            status: failed ? 'FAILED' : 'PENDING',
            lastError,
            availableAt: new Date(now.getTime() + backoffMs),
            failedAt: failed ? now : null,
          })
          .where('id', '=', event.id)
          .execute();
        // Giving up is an event the company's administrators must be able to find later.
        if (failed && event.companyId) {
          await writeAudit(
            tx,
            [
              {
                entityType: 'system.outbox_event',
                entityId: event.id,
                after: { status: 'FAILED', attempts: event.attempts },
                metadata: { topic: event.topic, aggregateId: event.aggregateId, lastError },
              },
            ],
            {
              actor: systemActor(`outbox:${event.id}`),
              command: 'system.outbox.failed',
              companyId: event.companyId,
              occurredAt: now,
            },
          );
        }
      });
      this.#logger.error(
        { err, topic: event.topic, eventId: event.id, attempt: event.attempts, failed },
        'outbox event failed',
      );
    }
  }
}

/**
 * Put a FAILED event of this company back in the queue, with a fresh set of attempts. Used by
 * the operations module's retry command (inside its transaction, so the bus audits it).
 */
export async function requeueFailedEvent(
  tx: DbTransaction,
  args: { companyId: string; eventId: string; now: Date },
): Promise<{ before: OutboxEvent; after: OutboxEvent }> {
  const before = await tx
    .selectFrom('system.outboxEvents')
    .selectAll()
    .where('id', '=', args.eventId)
    .where('companyId', '=', args.companyId)
    .forUpdate()
    .executeTakeFirst();
  if (!before) throw new NotFoundError('Background job');
  if (before.status !== 'FAILED') {
    throw new BusinessRuleError(
      'OUTBOX_NOT_FAILED',
      `This background job is ${before.status.toLowerCase()}, not failed; there is nothing to retry`,
    );
  }
  const after = await tx
    .updateTable('system.outboxEvents')
    .set({ status: 'PENDING', attempts: 0, availableAt: args.now, failedAt: null })
    .where('id', '=', before.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { before, after };
}

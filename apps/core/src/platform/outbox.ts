import { sql, type Selectable } from 'kysely';
import type { Database, DbTransaction } from '../db/database';
import type { SystemOutboxEvents } from '../db/schema.generated';
import type { Logger } from '../logger';
import type { Clock } from './clock';
import { uuidv7 } from './ids';
import { toJsonb } from './json';

export interface OutboxRecord {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export type OutboxEvent = Selectable<SystemOutboxEvents>;

/** Handlers must be idempotent: delivery is at-least-once. */
export type OutboxHandler = (ctx: {
  tx: DbTransaction;
  event: OutboxEvent;
  now: Date;
}) => Promise<void>;

export async function enqueueOutbox(
  tx: DbTransaction,
  records: readonly OutboxRecord[],
  now: Date,
): Promise<void> {
  await tx
    .insertInto('system.outboxEvents')
    .values(
      records.map((r) => ({
        id: uuidv7(now.getTime()),
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
      await this.#db.transaction().execute(async (tx) => {
        await handler({ tx, event, now });
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
      await this.#db
        .updateTable('system.outboxEvents')
        .set({
          status: failed ? 'FAILED' : 'PENDING',
          lastError: err instanceof Error ? err.message.slice(0, 2000) : String(err),
          availableAt: new Date(now.getTime() + backoffMs),
        })
        .where('id', '=', event.id)
        .execute();
      this.#logger.error(
        { err, topic: event.topic, eventId: event.id, attempt: event.attempts, failed },
        'outbox event failed',
      );
    }
  }
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { createLogger } from '../../logger';
import { fixedClock } from '../../platform/clock';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../platform/errors';
import { enqueueOutbox, OutboxDispatcher, type OutboxHandler } from '../../platform/outbox';
import { listOutboxEvents, retryOutboxEvent } from './index';

let env: TestEnv;
let fx: Fixture;
let other: Fixture;
let healthy = false;
let deliveries = 0;

/** A job whose handler fails until `healthy` is set — like a PDF renderer that is down. */
const flaky: OutboxHandler = {
  apply: () => {
    deliveries++;
    return healthy ? Promise.resolve() : Promise.reject(new Error('renderer unavailable'));
  },
};
/** A dispatcher whose clock reads `hours` after 2030-01-01, past every earlier backoff. */
const dispatcher = (hours: number) =>
  new OutboxDispatcher({
    db: env.services.db,
    clock: fixedClock(new Date(Date.UTC(2030, 0, 1, hours))),
    logger: createLogger('silent'),
    handlers: { 'test.flaky': flaky },
    maxAttempts: 2,
  });
let eventId = '';

beforeAll(async () => {
  env = await createTestEnv();
  fx = await createFixture(env.services);
  other = await createFixture(env.services, { tag: 'bravo' });
  await env.services.db.transaction().execute((tx) =>
    enqueueOutbox(
      tx,
      [
        {
          topic: 'test.flaky',
          aggregateType: 'sales.invoice',
          aggregateId: crypto.randomUUID(),
          payload: {},
        },
      ],
      new Date(),
      fx.companyId,
    ),
  );
  eventId = (
    await env.services.db
      .selectFrom('system.outboxEvents')
      .select('id')
      .where('topic', '=', 'test.flaky')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => env.destroy());

const list = (status: 'FAILED' | 'PENDING' = 'FAILED') =>
  env.services.queries.execute(listOutboxEvents, { status }, fx.actors.owner);

describe('failed background jobs', () => {
  it('gives up after the last attempt: FAILED, timestamped and audited for the company', async () => {
    await dispatcher(1).runOnce();
    await dispatcher(2).runOnce();
    const row = await env.ownerDb
      .selectFrom('system.outboxEvents')
      .selectAll()
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lastError: 'renderer unavailable',
      companyId: fx.companyId,
    });
    expect(row.failedAt).not.toBeNull();
    const audit = await env.ownerDb
      .selectFrom('audit.events')
      .select(['command', 'companyId', 'actorKind', 'metadata'])
      .where('entityId', '=', eventId)
      .execute();
    expect(audit).toContainEqual(
      expect.objectContaining({
        command: 'system.outbox.failed',
        companyId: fx.companyId,
        actorKind: 'system',
      }),
    );
    // Nothing retries it behind anyone's back.
    await dispatcher(3).runOnce();
    expect(deliveries).toBe(2);
  });

  it("is visible to the company's administrators — and only to them", async () => {
    const overview = await list();
    expect(overview.failed).toBe(1);
    expect(overview.events.map((e) => e.id)).toEqual([eventId]);
    expect(overview.events[0]).toMatchObject({
      topic: 'test.flaky',
      lastError: 'renderer unavailable',
    });
    expect(
      (await env.services.queries.execute(listOutboxEvents, {}, other.actors.owner)).events,
    ).toEqual([]);
    await expect(
      env.services.queries.execute(listOutboxEvents, {}, fx.actors.accountant),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      env.services.queries.execute(listOutboxEvents, {}, asAiAgent(fx.actors.owner)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('can be retried once its cause is fixed; the retry is audited and then succeeds', async () => {
    await expect(
      env.services.commands.execute(retryOutboxEvent, { eventId }, other.actors.owner),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      env.services.commands.execute(retryOutboxEvent, { eventId }, asAiAgent(fx.actors.owner)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const retried = await env.services.commands.execute(
      retryOutboxEvent,
      { eventId },
      fx.actors.owner,
    );
    expect(retried).toMatchObject({ status: 'PENDING', attempts: 0, failedAt: null });
    expect((await list('PENDING')).events.map((e) => e.id)).toEqual([eventId]);
    await expect(
      env.services.commands.execute(retryOutboxEvent, { eventId }, fx.actors.owner),
    ).rejects.toBeInstanceOf(BusinessRuleError);

    healthy = true;
    await dispatcher(4).runOnce();
    const row = await env.ownerDb
      .selectFrom('system.outboxEvents')
      .select(['status', 'lastError'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'DONE', lastError: null });
    const audit = await env.ownerDb
      .selectFrom('audit.events')
      .select('command')
      .where('entityId', '=', eventId)
      .execute();
    expect(audit.map((a) => a.command).sort()).toEqual([
      'operations.outbox.retry',
      'system.outbox.failed',
    ]);
  });
});

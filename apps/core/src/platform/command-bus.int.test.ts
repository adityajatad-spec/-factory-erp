import { PERMISSIONS } from '@factory-erp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { asAiAgent, createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { createParty } from '../modules/parties/commands';
import { createInvoiceDraft } from '../modules/sales/draft-commands';
import { issueInvoice } from '../modules/sales/issue-command';
import { defineCommand } from './commands';
import {
  BusinessRuleError,
  ForbiddenError,
  IdempotencyKeyReusedError,
  UnauthenticatedError,
  ValidationError,
} from './errors';

let env: TestEnv;
let fx: Fixture;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const auditCount = async (command: string) =>
  Number(
    (
      await env.services.db
        .selectFrom('audit.events')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('command', '=', command)
        .executeTakeFirstOrThrow()
    ).n,
  );

const partyInput = (code: string) => ({
  code,
  name: `Party ${code}`,
  isCustomer: true,
  isSupplier: false,
  stateCode: '27',
});

describe('command bus pipeline', () => {
  it('rejects invalid input before touching the database', async () => {
    await expect(
      env.services.commands.execute(createParty, { code: '', name: 'x' }, fx.actors.owner),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects anonymous callers', async () => {
    await expect(
      env.services.commands.execute(createParty, partyInput('ANON'), {
        requestId: 'r',
        user: null,
        actorKind: 'user',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('enforces permissions (a WORKER cannot create customers or invoices)', async () => {
    await expect(
      env.services.commands.execute(createParty, partyInput('W-TRY'), fx.actors.worker),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('writes exactly one audit event per command, attributed to the actor', async () => {
    const before = await auditCount('parties.create');
    const party = await env.services.commands.execute(
      createParty,
      partyInput('AUDITED'),
      fx.actors.accountant,
    );
    expect(await auditCount('parties.create')).toBe(before + 1);
    const event = await env.services.db
      .selectFrom('audit.events')
      .selectAll()
      .where('entityId', '=', party.id)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      actorUserId: fx.actors.accountant.user.id,
      actorKind: 'user',
      requestId: 'test-accountant',
    });
  });

  it('rolls back everything — including the audit row — when the handler fails', async () => {
    const failing = defineCommand({
      name: 'test.failing',
      description: 'writes then throws',
      input: z.object({}),
      permission: PERMISSIONS.partyCreate,
      ai: { tier: 'FORBIDDEN' },
      handler: async ({ tx }) => {
        await tx
          .insertInto('platform.states')
          .values({ code: '98', name: 'Should roll back' })
          .execute();
        throw new BusinessRuleError('NOPE', 'deliberate failure');
      },
    });
    await expect(
      env.services.commands.execute(failing, {}, fx.actors.owner),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    const state = await env.services.db
      .selectFrom('platform.states')
      .select('code')
      .where('code', '=', '98')
      .executeTakeFirst();
    expect(state).toBeUndefined();
    expect(await auditCount('test.failing')).toBe(0);
  });
});

describe('idempotency', () => {
  it('replays the stored result for a repeated key without executing twice', async () => {
    const key = 'idem-key-replay-0001';
    const first = await env.services.commands.execute(
      createParty,
      partyInput('IDEM-1'),
      fx.actors.owner,
      { idempotencyKey: key },
    );
    const again = await env.services.commands.execute(
      createParty,
      partyInput('IDEM-1'),
      fx.actors.owner,
      { idempotencyKey: key },
    );
    expect(again).toEqual(JSON.parse(JSON.stringify(first)));
    const rows = await env.services.db
      .selectFrom('party.parties')
      .select('id')
      .where('code', '=', 'IDEM-1')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects the same key reused for a different request', async () => {
    const key = 'idem-key-reuse-0002';
    await env.services.commands.execute(createParty, partyInput('IDEM-2'), fx.actors.owner, {
      idempotencyKey: key,
    });
    await expect(
      env.services.commands.execute(createParty, partyInput('IDEM-3'), fx.actors.owner, {
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('handles concurrent duplicates: one execution, identical responses', async () => {
    const key = 'idem-key-concurrent-03';
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        env.services.commands.execute(createParty, partyInput('IDEM-C'), fx.actors.owner, {
          idempotencyKey: key,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await env.services.db
      .selectFrom('party.parties')
      .select('id')
      .where('code', '=', 'IDEM-C')
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('AI tiers (no privileged path for the copilot)', () => {
  it('allows the AI to prepare a DRAFT invoice as the user', async () => {
    const draft = await env.services.commands.execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: '2026-01-15',
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }],
      },
      asAiAgent(fx.actors.accountant),
    );
    expect(draft.status).toBe('DRAFT');
    const event = await env.services.db
      .selectFrom('audit.events')
      .selectAll()
      .where('entityId', '=', draft.id)
      .executeTakeFirstOrThrow();
    expect(event.actorKind).toBe('ai_agent');
    expect(event.aiSessionId).not.toBeNull();
  });

  it('never lets the AI issue an invoice (CONFIRM tier needs a human)', async () => {
    const draft = await env.services.commands.execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: '2026-01-15',
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }],
      },
      fx.actors.accountant,
    );
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: draft.id, expectedVersion: draft.version },
        asAiAgent(fx.actors.owner),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('gives the AI no more permissions than its user', async () => {
    await expect(
      env.services.commands.execute(
        createInvoiceDraft,
        {
          customerId: fx.customers.intra.id,
          invoiceDate: '2026-01-15',
          lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '1' }],
        },
        asAiAgent(fx.actors.worker),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

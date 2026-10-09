import {
  ProviderError,
  type AbortSignalLike,
  type AiGateway,
  type ModelInfo,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
} from '@factory-erp/ai';
import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { AI_DISABLED } from '../config';
import { getAiPolicy, setAiPolicy } from '../modules/copilot';
import { reloadSessionUser } from '../modules/identity';
import { createSession } from '../modules/identity/sessions';
import { createParty } from '../modules/parties';
import type { Actor, AuthenticatedActor } from '../platform/actor';
import { ForbiddenError } from '../platform/errors';
import { defineQuery, type QueryBus, type QueryOptions } from '../platform/queries';
import { buildRegistry } from '../registry';
import {
  createCopilot,
  type CopilotLimits,
  type CopilotLogger,
  type CopilotTurnResult,
} from './copilot';
import { FAKE_MODEL_ID } from './fake-provider';
import { createAiGateway } from './gateway';
import { buildToolCatalog } from './tools';
import { z } from 'zod';

/**
 * The copilot entry point against a real database, the real query bus, the real policy store and
 * the real gateway — only the model is scripted. Every "zero provider calls" is counted on the
 * adapter itself.
 */
let env: TestEnv;
let A: Fixture;
let B: Fixture;
const catalog = () => buildToolCatalog(buildRegistry({ blobStore: env.services.blobStore }));

beforeAll(async () => {
  env = await createTestEnv();
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' }); // never gets a policy
  await setPolicy(A);
  // A customer with contact details the model must never see.
  await env.services.commands.execute(
    createParty,
    {
      code: 'C-PRIVATE',
      name: 'Private Contact Traders',
      isCustomer: true,
      isSupplier: false,
      stateCode: '27',
      addressLine1: '12 Hidden Lane',
      city: 'Nashik',
      postalCode: '422001',
      contactName: 'Ravi Contactperson',
      phone: '9876501234',
      email: 'ravi.private@example.test',
    },
    A.actors.owner,
  );
});
afterAll(async () => env.destroy());

// ---------------------------------------------------------------------------------------------
// Test doubles: a scripted local model, a recording query bus, a recording logger.

const MODEL = 'local:test';
const modelInfo: ModelInfo = {
  id: MODEL,
  providerId: 'local',
  locality: 'LOCAL',
  capabilities: ['chat', 'tools', 'structured'],
  contextTokens: 32_000,
  priceInPerMTokMicroInr: 0n,
  priceOutPerMTokMicroInr: 0n,
};

type ScriptStep = (
  req: NormalizedRequest,
  signal: AbortSignalLike,
) => Promise<NormalizedResponse> | NormalizedResponse;

function scriptedModel(steps: ScriptStep[]) {
  const model: ProviderAdapter & { calls: number; requests: NormalizedRequest[] } = {
    id: 'local',
    locality: 'LOCAL',
    calls: 0,
    requests: [] as NormalizedRequest[],
    listModels: () => Promise.resolve([modelInfo]),
    health: () => Promise.resolve({ ok: true }),
    invoke: async (_m: string, req: NormalizedRequest, signal: AbortSignalLike) => {
      model.calls++;
      model.requests.push(structuredClone(req));
      const step = steps.shift();
      if (!step) throw new ProviderError('MALFORMED_RESPONSE', 'script exhausted');
      return step(req, signal);
    },
  };
  return model;
}

const say =
  (text: string): ScriptStep =>
  () => ({ text, toolCalls: [], inputTokens: null, outputTokens: null });
const callTools =
  (...calls: [string, unknown][]): ScriptStep =>
  () => ({
    text: '',
    toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, name, arguments: args })),
    inputTokens: null,
    outputTokens: null,
  });
/** A model that never answers and ignores its abort signal. */
const hang: ScriptStep = () => new Promise<NormalizedResponse>(() => undefined);

interface QueryCall {
  name: string;
  args: unknown;
  actor: Actor;
  opts: QueryOptions | undefined;
}
function recordingQueries(
  hooks: {
    before?: (name: string) => Promise<void> | void;
    after?: (name: string) => Promise<void> | void;
    /** Return a value to answer instead of the real query; undefined runs the real one. */
    replace?: (name: string, actor: Actor, opts?: QueryOptions) => Promise<unknown>;
  } = {},
) {
  const log: QueryCall[] = [];
  const queries: Pick<QueryBus, 'execute'> = {
    execute: async (query, args, actor, opts) => {
      log.push({ name: query.name, args: structuredClone(args), actor, opts });
      await hooks.before?.(query.name);
      if (hooks.replace) {
        const replaced = await hooks.replace(query.name, actor, opts);
        if (replaced !== undefined) return replaced as never;
      }
      const r = await env.services.queries.execute(query, args, actor, opts);
      await hooks.after?.(query.name);
      return r;
    },
  };
  return { queries, log, names: () => log.map((c) => c.name) };
}

function recordingLogger() {
  const lines: { level: 'info' | 'warn'; obj: Record<string, unknown>; msg: string }[] = [];
  const logger: CopilotLogger = {
    info: (obj, msg) => lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
  };
  return {
    logger,
    lines,
    // Errors are rendered with their message, as a log serializer would: so any raw error that
    // reached the logger would show up in these assertions.
    text: () => JSON.stringify(lines, (_k, v: unknown) => (v instanceof Error ? v.message : v)),
  };
}

function setup(
  steps: ScriptStep[],
  opts: {
    hooks?: Parameters<typeof recordingQueries>[0];
    limits?: Partial<CopilotLimits>;
    gatewayTimeoutMs?: number;
    aiOff?: boolean;
    gateway?: AiGateway;
  } = {},
) {
  const model = scriptedModel(steps);
  const gateway = createAiGateway({
    adapters: [model],
    models: [modelInfo],
    timeoutMs: opts.gatewayTimeoutMs ?? 10_000,
  });
  const q = recordingQueries(opts.hooks);
  const log = recordingLogger();
  const copilot = createCopilot({
    ai: { gateway: opts.aiOff ? null : (opts.gateway ?? gateway) },
    queries: q.queries,
    catalog: catalog(),
    currentUser: (user) => reloadSessionUser(env.services.db, user, new Date()),
    logger: log.logger,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return { copilot, model, q, log };
}

async function setPolicy(
  fx: Fixture,
  over: { aiEnabled?: boolean; models?: string[]; maxDataClass?: string } = {},
) {
  const current = await env.services.queries.execute(getAiPolicy, {}, fx.actors.owner);
  await env.services.commands.execute(
    setAiPolicy,
    {
      expectedVersion: current?.version ?? 0,
      aiEnabled: over.aiEnabled ?? true,
      tasks: {
        'copilot.answer': {
          maxDataClass: over.maxDataClass ?? 'CONFIDENTIAL',
          approvedModels: (over.models ?? [MODEL]).map((modelId) => ({
            modelId,
            p95LatencyMs: 1000,
          })),
          fallback: false,
        },
      },
      reason: 'Test policy change',
    },
    fx.actors.owner,
  );
}

const ask = (question = 'Who are our customers?') => ({ question });
/** The text of the tool results the model was given in a request. */
const toolResults = (req: NormalizedRequest | undefined) =>
  (req?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
const offeredTools = (req: NormalizedRequest | undefined) =>
  (req?.tools ?? []).map((t) => t.name).sort();

// Every test starts from A's enabled policy approving the scripted model.
beforeEach(async () => {
  const current = await env.services.queries.execute(getAiPolicy, {}, A.actors.owner);
  const rules = (
    current?.tasks as Record<
      string,
      { approvedModels: { modelId: string }[]; maxDataClass: string }
    >
  )['copilot.answer'];
  if (
    !current?.aiEnabled ||
    rules?.maxDataClass !== 'CONFIDENTIAL' ||
    rules.approvedModels.map((m) => m.modelId).join() !== MODEL
  ) {
    await setPolicy(A);
  }
});

// ---------------------------------------------------------------------------------------------

describe('the current company policy gates every model call', () => {
  it('no stored policy: blocked before any provider call', async () => {
    const { copilot, model } = setup([say('never')]);
    const r = await copilot.answer(B.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 0 });
    expect(model.calls).toBe(0);
  });

  it('a disabled policy: blocked before any provider call', async () => {
    await setPolicy(A, { aiEnabled: false });
    const { copilot, model } = setup([say('never')]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 0 });
    expect(model.calls).toBe(0);
  });

  it("another company's policy (a lookup that returns the wrong row): blocked, zero calls", async () => {
    const foreign = await env.services.queries.execute(getAiPolicy, {}, A.actors.owner);
    expect(foreign?.aiEnabled).toBe(true);
    const { copilot, model } = setup([say('never')], {
      hooks: { replace: (name) => Promise.resolve(name === 'ai.policy.get' ? foreign : undefined) },
    });
    const r = await copilot.answer(B.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 0 });
    expect(model.calls).toBe(0);
  });

  it('a policy lookup that fails: blocked, zero calls', async () => {
    const { copilot, model } = setup([say('never')], {
      hooks: {
        before: (name) => {
          if (name === 'ai.policy.get') throw new Error('connection reset');
        },
      },
    });
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_UNAVAILABLE', modelCalls: 0 });
    expect(model.calls).toBe(0);
  });

  it('AI switched off in configuration: no gateway, zero calls', async () => {
    const { copilot, model } = setup([say('never')], { aiOff: true });
    expect(await copilot.answer(A.actors.owner, ask())).toMatchObject({
      ok: false,
      reason: 'AI_DISABLED',
    });
    expect(model.calls).toBe(0);
  });

  it('answers under an enabled policy, and a policy disabled afterwards blocks the next call', async () => {
    const { copilot, model } = setup([say('We have four customers.'), say('never')]);
    const first = await copilot.answer(A.actors.owner, ask());
    expect(first).toMatchObject({
      ok: true,
      answer: 'We have four customers.',
      servedBy: { modelId: MODEL, locality: 'LOCAL' },
    });
    expect(model.calls).toBe(1);

    await setPolicy(A, { aiEnabled: false });
    const second = await copilot.answer(A.actors.owner, ask());
    expect(second).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 0 });
    expect(model.calls).toBe(1);
  });

  it('a model no longer approved is not called again', async () => {
    const { copilot, model } = setup([say('first'), say('never')]);
    expect((await copilot.answer(A.actors.owner, ask())).ok).toBe(true);
    await setPolicy(A, { models: ['local:another-model'] });
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED' });
    expect(model.calls).toBe(1);
  });

  it('the policy is resolved again before and after every model call and before every tool, in order', async () => {
    const { copilot, model, q } = setup([
      callTools(['parties_list', {}], ['inventory_stock_list', {}]),
      say('Done.'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: true, modelCalls: 2 });
    expect(q.names()).toEqual([
      'ai.policy.get', // before model call 1
      'ai.policy.get', // as soon as model call 1 returns
      'ai.policy.get', // before tool 1
      'parties.list',
      'ai.policy.get', // before tool 2
      'inventory.stock.list',
      'ai.policy.get', // before model call 2
      'ai.policy.get', // as soon as model call 2 returns, before its answer is delivered
    ]);
    expect(model.calls).toBe(2);
  });

  it('a policy revoked after the model proposed a tool call: the tool never runs', async () => {
    const { copilot, model, q } = setup([
      async () => {
        await setPolicy(A, { aiEnabled: false }); // revoked while the model is "thinking"
        return callTools(['parties_list', {}])({} as never, {} as never);
      },
      say('never'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED' });
    expect(q.names()).not.toContain('parties.list');
    expect(model.calls).toBe(1);
  });

  it('a policy revoked during a tool execution: the next model call in the same turn is blocked', async () => {
    const { copilot, model, q } = setup([callTools(['parties_list', {}]), say('never')], {
      hooks: {
        after: async (name) => {
          if (name === 'parties.list') await setPolicy(A, { aiEnabled: false });
        },
      },
    });
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 1 });
    expect(q.names().filter((n) => n === 'parties.list')).toHaveLength(1);
    expect(model.calls).toBe(1);
  });

  it('a lowered data ceiling: CONFIDENTIAL tools are not offered or run, and a turn already holding CONFIDENTIAL data stops', async () => {
    await setPolicy(A, { maxDataClass: 'INTERNAL' });
    const low = setup([callTools(['parties_list', {}]), say('ok')]);
    const r = await low.copilot.answer(A.actors.owner, ask());
    expect(offeredTools(low.model.requests[0])).toEqual([
      'inventory_stock_list',
      'inventory_warehouses_list',
    ]);
    expect(r.toolCalls).toEqual([{ tool: null, outcome: 'UNKNOWN_TOOL' }]);
    expect(low.q.names()).not.toContain('parties.list');

    await setPolicy(A);
    const mid = setup([callTools(['parties_list', {}]), say('never')], {
      hooks: {
        after: async (name) => {
          if (name === 'parties.list') await setPolicy(A, { maxDataClass: 'INTERNAL' });
        },
      },
    });
    const r2 = await mid.copilot.answer(A.actors.owner, ask());
    // The conversation now holds CONFIDENTIAL data; the policy allows INTERNAL: the gateway
    // refuses the second call without contacting the provider.
    expect(r2).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', modelCalls: 2 });
    expect(mid.model.calls).toBe(1);
  });
});

describe('who and where come from the session, never from the client or the model', () => {
  it('a request naming a company, user, permissions or actor is refused before anything runs', async () => {
    const { copilot, model, q } = setup([say('never')]);
    for (const request of [
      { question: 'hi', companyId: B.companyId },
      { question: 'hi', userId: B.actors.owner.user.id },
      { question: 'hi', permissions: ['ai.policy.manage'] },
      { question: 'hi', actorKind: 'system' },
      { question: 'hi', dataClass: 'PUBLIC' },
      { question: '   ' },
      { question: 'x'.repeat(2001) },
      'just a string',
      null,
    ]) {
      const r = await copilot.answer(A.actors.owner, request);
      expect(r, JSON.stringify(request)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    }
    expect(model.calls).toBe(0);
    expect(q.log).toHaveLength(0);
  });

  it('only a person can start a turn: an AI actor cannot', async () => {
    const { copilot, model } = setup([say('never')]);
    const r = await copilot.answer(asAiAgent(A.actors.owner), ask());
    expect(r).toMatchObject({ ok: false, reason: 'NOT_AUTHORIZED' });
    expect(model.calls).toBe(0);
  });

  it("tools run as the AI actor of the session's person and company; identity arguments are refused", async () => {
    const { copilot, model, q } = setup([
      callTools(
        ['parties_list', { companyId: B.companyId }],
        ['parties_list', { role: 'customer' }],
      ),
      say('Listed.'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([
      { tool: null, outcome: 'INVALID_ARGUMENTS' },
      { tool: 'parties.list', outcome: 'OK' },
    ]);
    const runs = q.log.filter((c) => c.name === 'parties.list');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toEqual({ role: 'customer' });
    const actor = runs[0]?.actor as AuthenticatedActor;
    expect(actor.actorKind).toBe('ai_agent');
    expect(actor.aiSessionId).toEqual(expect.any(String));
    expect(actor.user.id).toBe(A.actors.owner.user.id);
    expect(actor.user.companyId).toBe(A.companyId);
    // Only A's data reached the model.
    const [refused, listed] = toolResults(model.requests[1]);
    expect(refused).toBe('{"ok":false,"error":"INVALID_ARGUMENTS","fields":["companyId"]}');
    expect(listed).toContain('Intra Customer alpha');
    expect(listed).not.toContain('bravo');
  });

  it('permissions are the person’s own, re-read at every step', async () => {
    // A worker holds no permission any tool needs: none is offered, none runs.
    const w = setup([callTools(['parties_list', {}]), say('I cannot see that.')]);
    const r = await w.copilot.answer(A.actors.worker, ask());
    expect(w.model.requests[0]?.tools).toBeUndefined();
    expect(r.toolCalls).toEqual([{ tool: null, outcome: 'UNKNOWN_TOOL' }]);
    expect(w.q.names()).not.toContain('parties.list');

    // The accountant loses the role while the model is generating: its response is discarded.
    const accountant = A.actors.accountant;
    const a = setup([
      async () => {
        await env.ownerDb
          .updateTable('identity.userRoles')
          .set({ roleCode: 'WORKER' })
          .where('userId', '=', accountant.user.id)
          .execute();
        return callTools(['parties_list', {}])({} as never, {} as never);
      },
      say('ok'),
    ]);
    try {
      const r2 = await a.copilot.answer(accountant, ask());
      expect(r2).toMatchObject({ ok: false, reason: 'AUTHORIZATION_CHANGED', toolCalls: [] });
      expect(a.q.names()).not.toContain('parties.list');
      expect(a.model.calls).toBe(1);
    } finally {
      await env.ownerDb
        .updateTable('identity.userRoles')
        .set({ roleCode: 'ACCOUNTANT' })
        .where('userId', '=', accountant.user.id)
        .execute();
    }
  });

  it('a person whose password must now be changed cannot start a turn (re-read, not the session flag)', async () => {
    const accountant = A.actors.accountant;
    expect(accountant.user.mustChangePassword).toBe(false);
    await env.ownerDb
      .updateTable('identity.users')
      .set({ mustChangePassword: true })
      .where('id', '=', accountant.user.id)
      .execute();
    try {
      const { copilot, model, q } = setup([say('never')]);
      const r = await copilot.answer(accountant, ask());
      expect(r).toMatchObject({ ok: false, reason: 'NOT_AUTHORIZED', modelCalls: 0 });
      expect(model.calls).toBe(0);
      expect(q.log).toHaveLength(0);
    } finally {
      await env.ownerDb
        .updateTable('identity.users')
        .set({ mustChangePassword: false })
        .where('id', '=', accountant.user.id)
        .execute();
    }
  });

  it('a person disabled mid-turn: the turn stops before the tool runs', async () => {
    const accountant = A.actors.accountant;
    const { copilot, q } = setup([
      async () => {
        await env.ownerDb
          .updateTable('identity.users')
          .set({ status: 'DISABLED' })
          .where('id', '=', accountant.user.id)
          .execute();
        return callTools(['parties_list', {}])({} as never, {} as never);
      },
    ]);
    try {
      const r = await copilot.answer(accountant, ask());
      expect(r).toMatchObject({ ok: false, reason: 'NOT_AUTHORIZED' });
      expect(q.names()).not.toContain('parties.list');
    } finally {
      await env.ownerDb
        .updateTable('identity.users')
        .set({ status: 'ACTIVE' })
        .where('id', '=', accountant.user.id)
        .execute();
    }
  });
});

describe('only READ tools with a projection, only through the query bus', () => {
  it('offers exactly the projected READ tools; DRAFT, CONFIRM, FORBIDDEN and unprojected ones never run', async () => {
    const ordersBefore = await env.ownerDb
      .selectFrom('purchase.orders')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const { copilot, model, q } = setup([
      callTools(
        ['purchase_order_createDraft', { supplierId: A.suppliers.local.id, lines: [] }], // DRAFT
        ['finance_supplierPayment_approve', { paymentId: A.companyId }], // CONFIRM
        ['ai_policy_set', { aiEnabled: false }], // FORBIDDEN
        ['identity_users_list', {}], // FORBIDDEN
        ['sales_invoices_get', { invoiceId: A.companyId }], // READ, but no projection yet
      ),
      say('Nothing done.'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(offeredTools(model.requests[0])).toEqual([
      'finance_payables_summary',
      'finance_receivables_summary',
      'inventory_stock_list',
      'inventory_warehouses_list',
      'parties_list',
    ]);
    expect(r.toolCalls.map((c) => c.outcome)).toEqual(Array(5).fill('UNKNOWN_TOOL'));
    expect(new Set(q.names())).toEqual(new Set(['ai.policy.get']));
    const ordersAfter = await env.ownerDb
      .selectFrom('purchase.orders')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(ordersAfter.n).toBe(ordersBefore.n);
  });

  it('the entry point has no command bus and no database handle', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'copilot.ts'), 'utf8');
    expect(src).not.toMatch(/CommandBus|platform\/commands|\.commands\b|db\/database|kysely/);
  });

  it("passes the model's original arguments to the bus, which validates them itself", async () => {
    const { copilot, q } = setup([
      callTools(['inventory_stock_list', { includeZero: 'true', limit: 5 }]),
      say('Stock listed.'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([{ tool: 'inventory.stock.list', outcome: 'OK' }]);
    // Unchanged: the string "true", not the boolean the schema would produce.
    expect(q.log.find((c) => c.name === 'inventory.stock.list')?.args).toEqual({
      includeZero: 'true',
      limit: 5,
    });
  });
});

describe('arguments and limits', () => {
  it('invalid and oversized arguments are refused without executing', async () => {
    const { copilot, model, q } = setup([
      callTools(['parties_list', { role: 'vendor' }], ['parties_list', { q: 'x'.repeat(3000) }]),
      say('ok'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([
      { tool: null, outcome: 'INVALID_ARGUMENTS' },
      { tool: null, outcome: 'ARGUMENTS_TOO_LARGE' },
    ]);
    expect(q.names()).not.toContain('parties.list');
    expect(toolResults(model.requests[1])).toEqual([
      '{"ok":false,"error":"INVALID_ARGUMENTS","fields":["role"]}',
      '{"ok":false,"error":"ARGUMENTS_TOO_LARGE"}',
    ]);
    // The oversized arguments are not echoed back into the conversation either.
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('x'.repeat(3000));
  });

  it('tool calls per turn are capped; the last model call is offered no tools', async () => {
    const four: [string, unknown][] = Array.from({ length: 4 }, () => [
      'inventory_warehouses_list',
      {},
    ]);
    const { copilot, model, q } = setup(
      [callTools(...four), callTools(...four), callTools(...four), say('Enough.')],
      { limits: { maxToolCalls: 6, maxModelCalls: 4 } },
    );
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: true, answer: 'Enough.' });
    expect(q.names().filter((n) => n === 'inventory.warehouses.list')).toHaveLength(6);
    expect(r.toolCalls.filter((c) => c.outcome === 'LIMIT_REACHED')).toHaveLength(6);
    expect(model.requests[2]?.tools).toBeUndefined(); // budget spent: no tools offered
    expect(model.requests[3]?.tools).toBeUndefined();
    expect(model.calls).toBe(4);
  });

  it('model calls per turn are capped', async () => {
    const { copilot, model } = setup(
      [callTools(['inventory_warehouses_list', {}]), callTools(['inventory_warehouses_list', {}])],
      { limits: { maxModelCalls: 2 } },
    );
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'TURN_LIMIT', modelCalls: 2 });
    expect(model.requests[1]?.tools).toBeUndefined();
    expect(model.calls).toBe(2);
  });

  it('a result is projected and cut to the size limit, or refused when even an empty page is too big', async () => {
    const small = setup([callTools(['parties_list', {}]), say('ok')], {
      limits: { maxToolResultChars: 400 },
    });
    const r = await small.copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([{ tool: 'parties.list', outcome: 'TRUNCATED' }]);
    const [text] = toolResults(small.model.requests[1]);
    expect(text?.length).toBeLessThanOrEqual(400);
    expect(JSON.parse(text ?? '')).toMatchObject({ ok: true, truncated: true, total: 5 });

    const tiny = setup([callTools(['parties_list', {}]), say('ok')], {
      limits: { maxToolResultChars: 40 },
    });
    const r2 = await tiny.copilot.answer(A.actors.owner, ask());
    expect(r2.toolCalls).toEqual([{ tool: 'parties.list', outcome: 'RESULT_TOO_LARGE' }]);
    expect(toolResults(tiny.model.requests[1])).toEqual([
      '{"ok":false,"error":"RESULT_TOO_LARGE"}',
    ]);
  });

  it('the whole turn is bounded in time, even when the model ignores cancellation', async () => {
    const { copilot, model } = setup([hang], {
      limits: { turnTimeoutMs: 150 },
      gatewayTimeoutMs: 60_000,
    });
    const t0 = Date.now();
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'TURN_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(model.calls).toBe(1);
  });

  it('cancellation stops the turn at once, even when the model ignores its signal', async () => {
    const { copilot, model } = setup([hang, say('never')]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    const r = await copilot.answer(A.actors.owner, ask(), { signal: controller.signal });
    expect(r).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(model.calls).toBe(1);
  });

  it('cancellation during a tool execution: no further model call', async () => {
    const controller = new AbortController();
    const { copilot, model } = setup([callTools(['parties_list', {}]), say('never')], {
      hooks: {
        before: (name) => {
          if (name === 'parties.list') controller.abort();
        },
      },
    });
    const r = await copilot.answer(A.actors.owner, ask(), { signal: controller.signal });
    expect(r).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(model.calls).toBe(1);
  });

  it('a request cancelled before it starts never reaches the model', async () => {
    const { copilot, model, q } = setup([say('never')]);
    const controller = new AbortController();
    controller.abort();
    const r = await copilot.answer(A.actors.owner, ask(), { signal: controller.signal });
    expect(r).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(model.calls).toBe(0);
    expect(q.log).toHaveLength(0);
  });
});

describe('what the model and the logs see', () => {
  it('contact details and internal fields are removed before results reach the model', async () => {
    const { copilot, model, log } = setup([callTools(['parties_list', {}]), say('Listed.')]);
    const question = 'List every customer with their phone number please';
    await copilot.answer(A.actors.owner, ask(question));
    const [text] = toolResults(model.requests[1]);
    expect(text).toContain('Private Contact Traders');
    for (const secret of [
      'Ravi Contactperson',
      '9876501234',
      'ravi.private@example.test',
      '12 Hidden Lane',
      '422001',
      'Nashik',
    ]) {
      expect(text).not.toContain(secret);
    }
    const rows = (JSON.parse(text ?? '') as { data: Record<string, unknown>[] }).data;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'code',
          'creditDays',
          'gstin',
          'id',
          'isCustomer',
          'isSupplier',
          'name',
          'receivableBalance',
          'stateCode',
          'stateName',
          'status',
        ].sort(),
      );
    }
    // Logs record what happened, never the question, the answer or the data.
    expect(log.text()).toContain('copilot turn');
    expect(log.text()).not.toContain(question);
    expect(log.text()).not.toContain('Private Contact Traders');
  });

  it('tool failures reach the model as a bare code: no message, SQL or permission name', async () => {
    const { copilot, model, log } = setup(
      [callTools(['parties_list', {}], ['inventory_stock_list', {}]), say('Sorry.')],
      {
        hooks: {
          before: (name) => {
            if (name === 'parties.list')
              throw new Error(
                'relation "party.parties" does not exist: SELECT * FROM party.parties',
              );
            if (name === 'inventory.stock.list')
              throw new ForbiddenError('inventory.secret.permission');
          },
        },
      },
    );
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([
      { tool: 'parties.list', outcome: 'TOOL_FAILED' },
      { tool: 'inventory.stock.list', outcome: 'NOT_PERMITTED' },
    ]);
    expect(toolResults(model.requests[1])).toEqual([
      '{"ok":false,"error":"TOOL_FAILED"}',
      '{"ok":false,"error":"NOT_PERMITTED"}',
    ]);
    expect(JSON.stringify(model.requests[1]?.messages)).not.toMatch(/SELECT|relation|secret/);
    // The log tells an infrastructure failure (warn) from an expected denial (info) by code,
    // without the exception text.
    const toolLines = log.lines.filter((l) => l.msg === 'copilot tool');
    expect(
      toolLines.map((l) => [l.level, l.obj.outcome, l.obj.category, l.obj.errorClass]),
    ).toEqual([
      ['warn', 'TOOL_FAILED', 'FAILURE', 'Error'],
      ['info', 'NOT_PERMITTED', 'DENIED', 'ForbiddenError'],
    ]);
    expect(toolLines[1]?.obj.errorCode).toBe('FORBIDDEN');
    expect(log.text()).not.toMatch(/SELECT|relation|secret/);
  });
});

/** A second session for a person, so a test can end it without touching the fixture's. */
async function newSession(actor: AuthenticatedActor, ttlHours = 1): Promise<AuthenticatedActor> {
  const { sessionId } = await createSession(env.services.db, {
    userId: actor.user.id,
    companyId: actor.user.companyId,
    ttlHours,
    now: new Date(),
    ip: null,
    userAgent: 'copilot test',
  });
  return { ...actor, user: { ...actor.user, sessionId } };
}

/** A tool that takes 5 s inside PostgreSQL. */
const slowQuery = defineQuery({
  name: 'test.slow',
  description: 'Sleeps in the database',
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db }) => {
    await sql`select pg_sleep(5)`.execute(db);
    return [];
  },
});
/** A tool whose SQL fails with a message that names a table. */
const brokenQuery = defineQuery({
  name: 'test.broken',
  description: 'Fails in the database',
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db }) => {
    await sql`select * from secret_table_name_xyz`.execute(db);
    return [];
  },
});
const runInstead =
  (target: string, query: typeof slowQuery) => (name: string, actor: Actor, opts?: QueryOptions) =>
    name === target
      ? env.services.queries.execute(query, {}, actor, opts)
      : Promise.resolve(undefined);
/** Statements of the slow tool still running in this test database. */
async function sleepers(): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from pg_stat_activity
     where datname = current_database() and state = 'active'
       and pid <> pg_backend_pid() and query like '%pg_sleep(5)%'`.execute(env.ownerDb);
  return Number(r.rows[0]?.n ?? 0);
}
async function waitFor(check: () => Promise<boolean> | boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}
/** A model step with a side effect while it is "generating". */
const meanwhile =
  (effect: () => Promise<unknown>, then: ScriptStep): ScriptStep =>
  async (req, signal) => {
    await effect();
    return then(req, signal);
  };

describe('authorisation is confirmed again as soon as a model call returns', () => {
  it('a final answer is withheld when the policy is switched off during generation', async () => {
    const { copilot, model } = setup([
      meanwhile(() => setPolicy(A, { aiEnabled: false }), say('Confidential answer 42')),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED' });
    expect(JSON.stringify(r)).not.toContain('Confidential answer 42');
    expect(model.calls).toBe(1);
  });

  it('a model no longer approved when it returns: answer withheld, tool calls not run', async () => {
    const { copilot, q } = setup([
      meanwhile(
        () => setPolicy(A, { models: ['local:another-model'] }),
        callTools(['parties_list', {}]),
      ),
    ]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'POLICY_BLOCKED', toolCalls: [] });
    expect(q.names()).not.toContain('parties.list');
  });

  it('any policy change during generation discards the response, even one that still allows it', async () => {
    const { copilot, q } = setup([meanwhile(() => setPolicy(A), callTools(['parties_list', {}]))]);
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'AUTHORIZATION_CHANGED', toolCalls: [] });
    expect(q.names()).not.toContain('parties.list');
  });

  it('a forced password change set during generation: nothing from the response is used', async () => {
    const accountant = A.actors.accountant;
    const flag = (value: boolean) =>
      env.ownerDb
        .updateTable('identity.users')
        .set({ mustChangePassword: value })
        .where('id', '=', accountant.user.id)
        .execute();
    const { copilot, q } = setup([meanwhile(() => flag(true), callTools(['parties_list', {}]))]);
    try {
      const r = await copilot.answer(accountant, ask());
      expect(r).toMatchObject({ ok: false, reason: 'NOT_AUTHORIZED', toolCalls: [] });
      expect(q.names()).not.toContain('parties.list');
    } finally {
      await flag(false);
    }
  });

  it('logout during generation (the real logout): the response is discarded and the session is done', async () => {
    const session = await newSession(A.actors.owner);
    const { copilot, model, q } = setup([
      meanwhile(() => env.services.auth.logout(session), say('Answer after logout')),
      say('never'),
    ]);
    const r = await copilot.answer(session, ask());
    expect(r).toMatchObject({ ok: false, reason: 'NOT_AUTHORIZED' });
    expect(JSON.stringify(r)).not.toContain('Answer after logout');
    expect(await copilot.answer(session, ask())).toMatchObject({
      ok: false,
      reason: 'NOT_AUTHORIZED',
      modelCalls: 0,
    });
    expect(model.calls).toBe(1);
    expect(q.names()).not.toContain('parties.list');
    // Other sessions of the same person are unaffected.
    const other = setup([say('still fine')]);
    expect(await other.copilot.answer(A.actors.owner, ask())).toMatchObject({ ok: true });
  });

  it('an expired session cannot start a turn', async () => {
    const expired = await newSession(A.actors.owner, 0);
    const { copilot, model } = setup([say('never')]);
    expect(await copilot.answer(expired, ask())).toMatchObject({
      ok: false,
      reason: 'NOT_AUTHORIZED',
    });
    expect(model.calls).toBe(0);
  });

  it("a session that is not the caller's own is refused (a forged session id)", async () => {
    const other = await newSession(A.actors.accountant);
    const forged: AuthenticatedActor = {
      ...A.actors.owner,
      user: { ...A.actors.owner.user, sessionId: other.user.sessionId },
    };
    const { copilot, model } = setup([say('never')]);
    expect(await copilot.answer(forged, ask())).toMatchObject({
      ok: false,
      reason: 'NOT_AUTHORIZED',
    });
    expect(model.calls).toBe(0);
  });

  it('a change between two tool calls of one response stops the remaining calls', async () => {
    const { copilot, model, q } = setup(
      [callTools(['parties_list', {}], ['inventory_warehouses_list', {}]), say('never')],
      {
        hooks: {
          after: async (name) => {
            if (name === 'parties.list') await setPolicy(A);
          },
        },
      },
    );
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({ ok: false, reason: 'AUTHORIZATION_CHANGED' });
    expect(q.names()).toContain('parties.list');
    expect(q.names()).not.toContain('inventory.warehouses.list');
    expect(model.calls).toBe(1);
  });
});

describe('database work of a tool is bounded', () => {
  it('a tool running past its statement limit ends the turn: no further model call, nothing left running', async () => {
    const { copilot, model, q } = setup([callTools(['parties_list', {}]), say('never')], {
      limits: { toolTimeoutMs: 200 },
      hooks: { replace: runInstead('parties.list', slowQuery) },
    });
    const t0 = Date.now();
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r).toMatchObject({
      ok: false,
      reason: 'TOOL_TIMEOUT',
      toolCalls: [{ tool: 'parties.list', outcome: 'TIMED_OUT' }],
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(model.calls).toBe(1);
    const run = q.log.find((c) => c.name === 'parties.list');
    expect(run?.opts?.timeoutMs).toBeGreaterThan(0);
    expect(run?.opts?.timeoutMs).toBeLessThanOrEqual(200);
    // PostgreSQL itself cancelled the statement (statement_timeout): nothing is still sleeping.
    expect(await sleepers()).toBe(0);
  });

  it('cancelling during a slow tool returns at once; the abandoned statement is ended by its own limit', async () => {
    const controller = new AbortController();
    let abortedAt = 0;
    const { copilot, model } = setup([callTools(['parties_list', {}]), say('never')], {
      limits: { toolTimeoutMs: 2_000 },
      hooks: {
        replace: (name, actor, opts) => {
          if (name === 'parties.list')
            setTimeout(() => {
              abortedAt = Date.now();
              controller.abort();
            }, 100);
          return runInstead('parties.list', slowQuery)(name, actor, opts);
        },
      },
    });
    const r = await copilot.answer(A.actors.owner, ask(), { signal: controller.signal });
    // Returned long before the statement could end (its limit is 2 s, the sleep 5 s).
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(r).toMatchObject({
      ok: false,
      reason: 'CANCELLED',
      toolCalls: [{ tool: 'parties.list', outcome: 'ABANDONED' }],
    });
    expect(model.calls).toBe(1);
    // The statement is not cancelled by the abort itself; statement_timeout ends it (≤ 2 s).
    expect(await waitFor(async () => (await sleepers()) === 0, 4_000)).toBe(true);
  });

  it('the statement limit never exceeds what is left of the turn', async () => {
    const { copilot, model, q } = setup([callTools(['parties_list', {}]), say('never')], {
      limits: { turnTimeoutMs: 1_500, toolTimeoutMs: 60_000 },
      hooks: { replace: runInstead('parties.list', slowQuery) },
    });
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.ok).toBe(false);
    expect(['TURN_TIMEOUT', 'TOOL_TIMEOUT']).toContain(r.ok ? null : r.reason);
    const budget = q.log.find((c) => c.name === 'parties.list')?.opts?.timeoutMs;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(1_500); // not the 60 s tool limit
    expect(model.calls).toBe(1);
    expect(await waitFor(async () => (await sleepers()) === 0, 4_000)).toBe(true);
  });
});

describe('logs carry codes, identifiers and durations — never content or raw errors', () => {
  it('a database error is logged by SQLSTATE, without its message', async () => {
    const { copilot, model, log } = setup([callTools(['parties_list', {}]), say('Sorry.')], {
      hooks: { replace: runInstead('parties.list', brokenQuery) },
    });
    const r = await copilot.answer(A.actors.owner, ask());
    expect(r.toolCalls).toEqual([{ tool: 'parties.list', outcome: 'TOOL_FAILED' }]);
    const line = log.lines.find((l) => l.msg === 'copilot tool');
    expect(line).toMatchObject({
      level: 'warn',
      obj: {
        tool: 'parties.list',
        outcome: 'TOOL_FAILED',
        category: 'FAILURE',
        errorClass: 'DatabaseError',
        errorCode: '42P01',
        requestId: A.actors.owner.requestId,
      },
    });
    expect(typeof line?.obj.aiSessionId).toBe('string');
    expect(typeof line?.obj.durationMs).toBe('number');
    expect(log.text()).not.toContain('secret_table_name_xyz');
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('secret_table_name_xyz');
  });

  it('credentials or SQL inside an exception message never reach the log', async () => {
    const leak =
      'connect postgres://factoryerp_app:hunter2@db:5432 failed during SELECT secret_col';
    const { copilot, log } = setup([callTools(['parties_list', {}]), say('Sorry.')], {
      hooks: {
        before: (name) => {
          if (name === 'parties.list') throw new Error(leak);
        },
      },
    });
    await copilot.answer(A.actors.owner, ask());
    expect(log.text()).not.toMatch(/hunter2|postgres:\/\/|secret_col|SELECT/);
    expect(log.lines.find((l) => l.msg === 'copilot tool')?.obj).toMatchObject({
      errorClass: 'Error',
      errorCode: null,
    });
  });

  it('an unexpected crash is logged as a class, and the turn fails closed', async () => {
    const crash = () => Promise.reject(new Error('token=hunter2 at http://127.0.0.1:11434'));
    const broken: AiGateway = {
      generate: crash,
      generateStructured: crash,
      embed: crash,
      vision: crash,
    };
    const { copilot, log } = setup([], { gateway: broken });
    const r = await copilot.answer(A.actors.owner, ask('What is our secret margin?'));
    expect(r).toMatchObject({ ok: false, reason: 'FAILED' });
    expect(log.lines.find((l) => l.msg === 'copilot turn failed')).toMatchObject({
      level: 'warn',
      obj: { errorClass: 'Error', errorCode: null },
    });
    expect(log.text()).not.toMatch(/hunter2|11434|secret margin/);
  });

  it('a successful turn logs no question, arguments, results or answer', async () => {
    const { copilot, log } = setup([
      callTools(['parties_list', { q: 'Private Contact' }]),
      say('The answer is Private Contact Traders.'),
    ]);
    const r = await copilot.answer(A.actors.owner, ask('Find the customer called Private Contact'));
    expect(r.ok).toBe(true);
    expect(log.lines.map((l) => l.msg)).toEqual(['copilot tool', 'copilot turn']);
    expect(log.text()).not.toMatch(/Private Contact|Find the customer/);
    expect(log.lines[1]?.obj).toMatchObject({ outcome: 'ANSWERED', modelCalls: 2 });
  });
});

describe('concurrent turns are bounded per process', () => {
  it('excess turns are refused at once (not queued), per process and per person', async () => {
    const { copilot, model, q } = setup([hang, hang, say('third'), say('fourth')], {
      limits: { maxConcurrentTurns: 2, maxConcurrentTurnsPerUser: 1 },
    });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const t1 = copilot.answer(A.actors.owner, ask(), { signal: c1.signal });
    const t2 = copilot.answer(A.actors.accountant, ask(), { signal: c2.signal });
    expect(copilot.activeTurns()).toBe(2);
    expect(await waitFor(() => model.calls === 2)).toBe(true);

    const queriesBefore = q.log.length;
    expect(await copilot.answer(A.actors.admin, ask())).toMatchObject({
      ok: false,
      reason: 'BUSY',
      modelCalls: 0,
    });
    expect(q.log.length).toBe(queriesBefore); // refused before any database work
    expect(model.calls).toBe(2);

    c1.abort();
    expect(await t1).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(copilot.activeTurns()).toBe(1);
    // Room in the process, but the accountant already has a turn running.
    expect(await copilot.answer(A.actors.accountant, ask())).toMatchObject({ reason: 'BUSY' });
    expect(await copilot.answer(A.actors.admin, ask())).toMatchObject({
      ok: true,
      answer: 'third',
    });

    c2.abort();
    expect(await t2).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(copilot.activeTurns()).toBe(0);
    expect(await copilot.answer(A.actors.accountant, ask())).toMatchObject({
      ok: true,
      answer: 'fourth',
    });
  });

  it('permits are released after success, failure, timeout, cancellation and refusal', async () => {
    const limits = { maxConcurrentTurns: 1, maxConcurrentTurnsPerUser: 1 };
    const outcomes: string[] = [];
    const check = async (
      steps: ScriptStep[],
      run: (c: ReturnType<typeof setup>['copilot']) => Promise<CopilotTurnResult>,
      extra: Partial<CopilotLimits> = {},
      gateway?: AiGateway,
    ) => {
      const s = setup(steps, { limits: { ...limits, ...extra }, ...(gateway ? { gateway } : {}) });
      const r = await run(s.copilot);
      outcomes.push(r.ok ? 'ANSWERED' : r.reason);
      expect(s.copilot.activeTurns()).toBe(0);
      // And the single permit is really free again.
      const next = setup([say('again')], { limits });
      expect((await next.copilot.answer(A.actors.owner, ask())).ok).toBe(true);
    };
    const crash = () => Promise.reject(new Error('boom'));
    await check([say('ok')], (c) => c.answer(A.actors.owner, ask()));
    await check([], (c) => c.answer(A.actors.owner, ask())); // script exhausted: model error
    await check(
      [],
      (c) => c.answer(A.actors.owner, ask()),
      {},
      {
        generate: crash,
        generateStructured: crash,
        embed: crash,
        vision: crash,
      },
    );
    await check([hang], (c) => c.answer(A.actors.owner, ask()), { turnTimeoutMs: 100 });
    await check([hang], (c) => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 50);
      return c.answer(A.actors.owner, ask(), { signal: ctl.signal });
    });
    await check([say('never')], (c) => c.answer(B.actors.owner, ask())); // no policy
    await check([say('never')], (c) => c.answer(A.actors.owner, { question: '' }));
    expect(outcomes).toEqual([
      'ANSWERED',
      'MODEL_ERROR',
      'FAILED',
      'TURN_TIMEOUT',
      'CANCELLED',
      'POLICY_BLOCKED',
      'INVALID_REQUEST',
    ]);
  });
});

describe('the composition root', () => {
  it('wires the copilot to the configured gateway (AI off by default)', async () => {
    expect(await env.services.copilot.answer(A.actors.owner, ask())).toMatchObject({
      ok: false,
      reason: 'AI_DISABLED',
    });
  });

  it('with the fake local provider and a policy approving it, a turn runs end to end', async () => {
    const fake = await createTestEnv({ ai: { config: { ...AI_DISABLED, provider: 'fake' } } });
    try {
      const F = await createFixture(fake.services, { tag: 'fake' });
      await fake.services.commands.execute(
        setAiPolicy,
        {
          expectedVersion: 0,
          aiEnabled: true,
          tasks: {
            'copilot.answer': {
              maxDataClass: 'CONFIDENTIAL',
              approvedModels: [{ modelId: FAKE_MODEL_ID, p95LatencyMs: 1000 }],
              fallback: false,
            },
          },
          reason: 'Enable the fake model',
        },
        F.actors.owner,
      );
      const r = await fake.services.copilot.answer(F.actors.accountant, ask('Hello there'));
      expect(r).toMatchObject({
        ok: true,
        answer: 'Fake reply: Hello there',
        servedBy: { modelId: FAKE_MODEL_ID, locality: 'LOCAL' },
        policyVersion: 1,
      });
    } finally {
      await fake.destroy();
    }
  });
});

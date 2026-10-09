import type { CopilotTurnResponse, ProblemDetails } from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import type { FetchLike } from '../ai/ollama';
import { AI_DISABLED } from '../config';
import { loggerOptions } from '../logger';
import { getAiPolicy, setAiPolicy } from '../modules/copilot';
import { createSession } from '../modules/identity/sessions';
import { createParty } from '../modules/parties';
import type { AuthenticatedActor } from '../platform/actor';
import { buildApp } from './app';

/**
 * POST /api/v1/ai/copilot/turns through the real app: session cookie, error handler, the real
 * Ollama adapter, gateway and copilot, and the real database. Only Ollama's HTTP API is
 * scripted (the adapter's injected fetch), so nothing here needs a model runtime.
 */
const URL_PATH = '/api/v1/ai/copilot/turns';
const MODEL = 'qwen2.5:7b';

// --- A scripted Ollama: /api/tags lists the model; each /api/chat takes the next step. --------
interface ChatBody {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
}
type ChatStep = () => Promise<{ status: number; body: unknown }>;
let steps: ChatStep[] = [];
const chats: ChatBody[] = [];
const respond = (status: number, body: unknown) =>
  Promise.resolve({
    ok: status < 400,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
const ollamaFetch: FetchLike = async (url, init) => {
  if (url.endsWith('/api/tags')) return respond(200, { models: [{ name: MODEL }] });
  chats.push(JSON.parse(init.body ?? '{}') as ChatBody);
  const step = steps.shift();
  const r = step
    ? await step()
    : { status: 200, body: { message: { role: 'assistant', content: '(unscripted)' } } };
  return respond(r.status, r.body);
};
const say =
  (content: string): ChatStep =>
  () =>
    Promise.resolve({ status: 200, body: { message: { role: 'assistant', content } } });
const callTools =
  (...calls: [string, unknown][]): ChatStep =>
  () =>
    Promise.resolve({
      status: 200,
      body: {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })),
        },
      },
    });
/** A model step that waits until the test opens it — or forever (it ignores cancellation). */
function gate() {
  let open: (content: string) => void = () => undefined;
  const reply = new Promise<{ status: number; body: unknown }>((resolve) => {
    open = (content) => resolve({ status: 200, body: { message: { role: 'assistant', content } } });
  });
  return { step: () => reply, open: (content: string) => open(content) };
}
const toolMessages = (chat: ChatBody | undefined) =>
  (chat?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content);

// --- Captured logs (the same pino configuration as production). -------------------------------
const logLines: string[] = [];
const logger = pino(loggerOptions('info', false), { write: (line: string) => logLines.push(line) });

let env: TestEnv;
let A: Fixture;
let B: Fixture;
let app: FastifyInstance;

beforeAll(async () => {
  env = await createTestEnv({
    ai: {
      config: { ...AI_DISABLED, provider: 'ollama', model: MODEL, timeoutMs: 10_000 },
      options: { fetch: ollamaFetch },
    },
    copilotLimits: { toolTimeoutMs: 1_000 },
    logger,
  });
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' });
  await setPolicy(A);
  await env.services.commands.execute(
    createParty,
    {
      code: 'C-PRIVATE',
      name: 'Private Contact Traders',
      isCustomer: true,
      isSupplier: false,
      stateCode: '27',
      addressLine1: '12 Hidden Lane',
      contactName: 'Ravi Contactperson',
      phone: '9876501234',
      email: 'ravi.private@example.test',
    },
    A.actors.owner,
  );
  app = await buildApp(env.services);
  // How many 'close' listeners each response still carries when it is finished (leak check).
  app.addHook('onResponse', (req, reply, done) => {
    closeListeners.push({ url: req.url, n: reply.raw.listenerCount('close') });
    done();
  });
});
const closeListeners: { url: string; n: number }[] = [];
afterAll(async () => {
  await app.close();
  await env.destroy();
});
beforeEach(() => {
  steps = [];
  chats.length = 0;
});

async function setPolicy(fx: Fixture, aiEnabled = true) {
  const current = await env.services.queries.execute(getAiPolicy, {}, fx.actors.owner);
  await env.services.commands.execute(
    setAiPolicy,
    {
      expectedVersion: current?.version ?? 0,
      aiEnabled,
      tasks: {
        'copilot.answer': {
          maxDataClass: 'CONFIDENTIAL',
          approvedModels: [{ modelId: `ollama:${MODEL}`, p95LatencyMs: 5_000 }],
          fallback: false,
        },
      },
      reason: 'Test policy',
    },
    fx.actors.owner,
  );
}

/** A real session row and its cookie (the same path login takes, without its rate limit). */
async function signIn(actor: AuthenticatedActor, ttlHours = 1) {
  const { sessionId, token } = await createSession(env.services.db, {
    userId: actor.user.id,
    companyId: actor.user.companyId,
    ttlHours,
    now: new Date(),
    ip: null,
    userAgent: 'copilot route test',
  });
  return { sessionId, cookie: `ferp_session=${token}` };
}
const turn = (cookie: string | null, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: URL_PATH,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload: payload as Record<string, unknown>,
  });
const ask = (question = 'Who are our customers?') => ({ question });
const code = (res: { json: () => unknown }) => (res.json() as ProblemDetails).code;

// ------------------------------------------------------------------------------------------------

describe('authentication goes through the existing session', () => {
  it('no session, a made-up token, a logged-out session and an expired one: 401, no AI work', async () => {
    expect((await turn(null, ask())).statusCode).toBe(401);
    expect((await turn('ferp_session=not-a-real-token-but-long-enough-xx', ask())).statusCode).toBe(
      401,
    );

    const revoked = await signIn(A.actors.owner);
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: revoked.cookie },
    });
    expect(out.statusCode).toBe(204);
    const r1 = await turn(revoked.cookie, ask());
    expect([r1.statusCode, code(r1)]).toEqual([401, 'UNAUTHENTICATED']);

    const expired = await signIn(A.actors.owner);
    await env.ownerDb
      .updateTable('identity.sessions')
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where('id', '=', expired.sessionId)
      .execute();
    expect((await turn(expired.cookie, ask())).statusCode).toBe(401);
    expect(chats).toHaveLength(0);
  });

  it('a person who must change their password is refused before any AI work', async () => {
    const worker = A.actors.worker;
    const { cookie } = await signIn(worker);
    await env.ownerDb
      .updateTable('identity.users')
      .set({ mustChangePassword: true })
      .where('id', '=', worker.user.id)
      .execute();
    try {
      const res = await turn(cookie, ask());
      expect([res.statusCode, code(res)]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
      expect(chats).toHaveLength(0);
    } finally {
      await env.ownerDb
        .updateTable('identity.users')
        .set({ mustChangePassword: false })
        .where('id', '=', worker.user.id)
        .execute();
    }
  });
});

describe('the request is exactly { question }', () => {
  it('identity, permission and data-class fields, bad questions and bad bodies are refused', async () => {
    const { cookie } = await signIn(A.actors.owner);
    for (const extra of [
      { companyId: B.companyId },
      { userId: B.actors.owner.user.id },
      { roles: ['OWNER'] },
      { permissions: ['ai.policy.manage'] },
      { actorKind: 'system' },
      { dataClass: 'PUBLIC' },
    ]) {
      const res = await turn(cookie, { question: 'hi', ...extra });
      expect([res.statusCode, code(res)], JSON.stringify(extra)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    for (const bad of [{ question: '' }, { question: '   ' }, { question: 'x'.repeat(2001) }, {}]) {
      expect((await turn(cookie, bad)).statusCode).toBe(400);
    }
    expect((await turn(cookie, ['question'])).statusCode).toBe(400);
    const plain = await app.inject({
      method: 'POST',
      url: URL_PATH,
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'question=hi',
    });
    expect(plain.statusCode).toBe(415);
    const huge = await turn(cookie, { question: 'hi', padding: 'x'.repeat(20_000) });
    expect(huge.statusCode).toBe(413);
    expect(chats).toHaveLength(0);
  });
});

describe('configuration and company policy', () => {
  it('AI switched off on the server: 503 AI_DISABLED', async () => {
    const off = await createTestEnv();
    try {
      const F = await createFixture(off.services, { tag: 'off' });
      const offApp = await buildApp(off.services);
      const { sessionId, token } = await createSession(off.services.db, {
        userId: F.actors.owner.user.id,
        companyId: F.companyId,
        ttlHours: 1,
        now: new Date(),
        ip: null,
        userAgent: 'test',
      });
      expect(sessionId).toBeTruthy();
      const res = await offApp.inject({
        method: 'POST',
        url: URL_PATH,
        headers: { cookie: `ferp_session=${token}` },
        payload: ask(),
      });
      expect([res.statusCode, code(res)]).toEqual([503, 'AI_DISABLED']);
      await offApp.close();
    } finally {
      await off.destroy();
    }
  });

  it('no policy, or a disabled one: 403 AI_POLICY_BLOCKED and the model is never called', async () => {
    const b = await signIn(B.actors.owner);
    const none = await turn(b.cookie, ask());
    expect([none.statusCode, code(none)]).toEqual([403, 'AI_POLICY_BLOCKED']);

    await setPolicy(A, false);
    try {
      const a = await signIn(A.actors.accountant);
      const off = await turn(a.cookie, ask());
      expect([off.statusCode, code(off)]).toEqual([403, 'AI_POLICY_BLOCKED']);
    } finally {
      await setPolicy(A, true);
    }
    expect(chats).toHaveLength(0);
  });
});

describe('a read-only turn', () => {
  it('answers with the minimal response; the model saw only projected data', async () => {
    const { cookie } = await signIn(A.actors.owner);
    steps = [callTools(['parties_list', {}]), say('There are five parties.')];
    const res = await turn(cookie, ask());
    expect(res.statusCode).toBe(200);
    expect(res.json<CopilotTurnResponse>()).toEqual({
      answer: 'There are five parties.',
      locality: 'LOCAL',
      toolsUsed: ['parties.list'],
      truncated: false,
    });
    // No model name or internal detail in the response.
    expect(res.body).not.toMatch(/qwen|ollama|policyVersion|aiSessionId/);
    // Offered tools: the five projected READ tools — nothing that writes.
    expect((chats[0]?.tools ?? []).map((t) => t.function.name).sort()).toEqual([
      'finance_payables_summary',
      'finance_receivables_summary',
      'inventory_stock_list',
      'inventory_warehouses_list',
      'parties_list',
    ]);
    const [listed] = toolMessages(chats[1]);
    expect(listed).toContain('Private Contact Traders');
    expect(listed).not.toMatch(/9876501234|ravi\.private|Hidden Lane|Contactperson/);
  });

  it('write-capable operations are never available, whatever the model asks for', async () => {
    const countOrders = async () =>
      (
        await env.ownerDb
          .selectFrom('purchase.orders')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n;
    const before = await countOrders();
    const { cookie } = await signIn(A.actors.owner);
    steps = [
      callTools(
        ['purchase_order_createDraft', { supplierId: A.suppliers.local.id, lines: [] }],
        ['finance_supplierPayment_approve', { paymentId: A.companyId }],
        ['ai_policy_set', { aiEnabled: false }],
      ),
      say('I cannot do that.'),
    ];
    const res = await turn(cookie, ask('Create and approve a purchase order'));
    expect(res.statusCode).toBe(200);
    expect(res.json<CopilotTurnResponse>().toolsUsed).toEqual([]);
    expect(toolMessages(chats[1])).toEqual(Array(3).fill('{"ok":false,"error":"UNKNOWN_TOOL"}'));
    expect(await countOrders()).toBe(before);
  });

  it("each company's turn sees only its own data", async () => {
    await setPolicy(B);
    const { cookie } = await signIn(B.actors.owner);
    steps = [callTools(['parties_list', {}]), say('Listed.')];
    const res = await turn(cookie, ask());
    expect(res.statusCode).toBe(200);
    const [listed] = toolMessages(chats[1]);
    expect(listed).toContain('bravo');
    expect(listed).not.toMatch(/alpha|Private Contact/);
  });
});

describe('checks stay effective during the turn', () => {
  it('logout while the model is working: 401, and its answer is not returned', async () => {
    const s = await signIn(A.actors.owner);
    const g = gate();
    steps = [g.step];
    const pending = turn(s.cookie, ask());
    await waitFor(() => chats.length === 1);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: s.cookie } });
    g.open('An answer that must not be delivered');
    const res = await pending;
    expect([res.statusCode, code(res)]).toEqual([401, 'UNAUTHENTICATED']);
    expect(res.body).not.toContain('must not be delivered');
  });

  it('the policy switched off while the model is working: 403, answer withheld', async () => {
    const s = await signIn(A.actors.owner);
    const g = gate();
    steps = [g.step];
    const pending = turn(s.cookie, ask());
    await waitFor(() => chats.length === 1);
    await setPolicy(A, false);
    try {
      g.open('Withheld answer');
      const res = await pending;
      expect([res.statusCode, code(res)]).toEqual([403, 'AI_POLICY_BLOCKED']);
      expect(res.body).not.toContain('Withheld answer');
    } finally {
      await setPolicy(A, true);
    }
  });
});

describe('failures map to fixed codes, never to provider or database text', () => {
  it('provider errors: 503 AI_UNAVAILABLE with fixed text', async () => {
    const { cookie } = await signIn(A.actors.owner);
    for (const step of [
      () =>
        Promise.resolve({ status: 500, body: 'panic: /home/ollama/models secret token=hunter2' }),
      () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.5:11434 token=hunter2')),
      () => Promise.resolve({ status: 200, body: 'not json hunter2' }),
    ]) {
      steps = [step];
      const res = await turn(cookie, ask());
      expect([res.statusCode, code(res)]).toEqual([503, 'AI_UNAVAILABLE']);
      expect(res.json<ProblemDetails>().title).toBe('The AI assistant is unavailable right now.');
      expect(res.body).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5|11434|panic/);
    }
  });

  it('the policy cannot be read (a database failure): 503, no SQL text', async () => {
    const { cookie } = await signIn(A.actors.owner);
    await sql`revoke select on ai.policy_versions from factoryerp_runtime`.execute(env.ownerDb);
    try {
      const res = await turn(cookie, ask());
      expect([res.statusCode, code(res)]).toEqual([503, 'AI_UNAVAILABLE']);
      expect(res.body).not.toMatch(/permission|policy_versions|denied|select/i);
    } finally {
      await sql`grant select on ai.policy_versions to factoryerp_runtime`.execute(env.ownerDb);
    }
    expect(chats).toHaveLength(0);
  });

  it('a tool whose table cannot be read: the model gets a bare code, the client an answer', async () => {
    const { cookie } = await signIn(A.actors.owner);
    steps = [callTools(['parties_list', {}]), say('I could not read the parties.')];
    await sql`revoke select on party.parties from factoryerp_runtime`.execute(env.ownerDb);
    try {
      const res = await turn(cookie, ask());
      expect(res.statusCode).toBe(200);
      expect(res.json<CopilotTurnResponse>().toolsUsed).toEqual([]);
      expect(toolMessages(chats[1])).toEqual(['{"ok":false,"error":"TOOL_FAILED"}']);
      expect(JSON.stringify(chats)).not.toMatch(/permission denied|party\.parties/);
    } finally {
      await sql`grant select on party.parties to factoryerp_runtime`.execute(env.ownerDb);
    }
  });

  it('a tool held up in the database past its limit: 504 AI_TIMEOUT', async () => {
    const { cookie } = await signIn(A.actors.owner);
    steps = [callTools(['parties_list', {}]), say('never')];
    const res = await env.ownerDb.transaction().execute(async (tx) => {
      await sql`lock table party.parties in access exclusive mode`.execute(tx);
      return turn(cookie, ask());
    });
    expect([res.statusCode, code(res)]).toEqual([504, 'AI_TIMEOUT']);
    expect(chats).toHaveLength(1); // no model call after the timed-out tool
  });
});

describe('cancellation and concurrency', () => {
  it('a client that disconnects cancels the turn and frees its permit', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const { cookie } = await signIn(A.actors.owner);
    steps = [gate().step]; // the model never answers and ignores cancellation
    const body = JSON.stringify(ask());
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: URL_PATH,
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'content-length': body.length },
    });
    req.on('error', () => undefined); // the socket is destroyed on purpose
    req.end(body);
    expect(await waitFor(() => chats.length === 1)).toBe(true);
    expect(env.services.copilot.activeTurns()).toBe(1);
    req.destroy();
    expect(await waitFor(() => env.services.copilot.activeTurns() === 0)).toBe(true);
    expect(chats).toHaveLength(1);
    expect(turnLogs().at(-1)).toMatchObject({ outcome: 'CANCELLED' });

    // The permit is really free: the next turn runs.
    steps = [say('Back again.')];
    const next = await turn(cookie, ask());
    expect(next.json<CopilotTurnResponse>().answer).toBe('Back again.');
  });

  it('excess turns get 429 AI_BUSY with Retry-After, never a queue; permits come back', async () => {
    const owner = await signIn(A.actors.owner);
    const accountant = await signIn(A.actors.accountant);
    const admin = await signIn(A.actors.admin);
    const g1 = gate();
    const g2 = gate();
    steps = [g1.step, g2.step];
    const t1 = turn(owner.cookie, ask());
    await waitFor(() => chats.length === 1);
    const t2 = turn(accountant.cookie, ask());
    await waitFor(() => chats.length === 2);
    expect(env.services.copilot.activeTurns()).toBe(2);

    const busy = await turn(admin.cookie, ask()); // the process limit (2)
    expect([busy.statusCode, code(busy)]).toEqual([429, 'AI_BUSY']);
    expect(busy.headers['retry-after']).toBe('5');
    expect(chats).toHaveLength(2);

    g1.open('first');
    expect((await t1).json<CopilotTurnResponse>().answer).toBe('first');
    const mine = await turn(accountant.cookie, ask()); // the per-person limit (1)
    expect([mine.statusCode, code(mine)]).toEqual([429, 'AI_BUSY']);

    steps.push(say('third'));
    const third = await turn(admin.cookie, ask());
    expect(third.json<CopilotTurnResponse>().answer).toBe('third');
    g2.open('second');
    expect((await t2).json<CopilotTurnResponse>().answer).toBe('second');
    expect(env.services.copilot.activeTurns()).toBe(0);
  });
});

describe('boundaries', () => {
  it('the route never reaches the model itself: it only calls the copilot', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'ai-routes.ts'), 'utf8');
    expect(src).toMatch(/deps\.copilot\.answer\(/);
    expect(src).not.toMatch(
      /\.gateway\b|\.generate\(|createAiGateway|ollamaAdapter|fakeProvider|from '@factory-erp\/ai'/,
    );
  });

  it('the route leaves no listener behind on finished responses', () => {
    const turns = closeListeners.filter((c) => c.url === URL_PATH).map((c) => c.n);
    const baseline = closeListeners.filter((c) => c.url !== URL_PATH).map((c) => c.n);
    expect(turns.length).toBeGreaterThan(10);
    expect(baseline.length).toBeGreaterThan(0);
    expect(new Set(turns)).toEqual(new Set(baseline));
  });

  it('nothing sensitive reached the logs over this whole file', () => {
    const text = logLines.join('\n');
    expect(turnLogs().length).toBeGreaterThan(5); // the copilot did log its turns
    for (const secret of [
      'hunter2',
      'ECONNREFUSED',
      '10.0.0.5',
      'permission denied',
      'Who are our customers',
      'There are five parties',
      'Private Contact Traders',
      '9876501234',
      'ravi.private',
      'must not be delivered',
      'Withheld answer',
      'ferp_session=',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

function turnLogs(): Record<string, unknown>[] {
  return logLines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === 'copilot turn');
}
async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

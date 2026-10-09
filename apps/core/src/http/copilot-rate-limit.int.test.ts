import type { CopilotTurnResponse, ProblemDetails } from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import type { FetchLike } from '../ai/ollama';
import { AI_DISABLED } from '../config';
import { loggerOptions } from '../logger';
import { setAiPolicy } from '../modules/copilot';
import { createSession } from '../modules/identity/sessions';
import type { AuthenticatedActor } from '../platform/actor';
import { createRateLimiter } from '../platform/rate-limiter';
import { buildApp } from './app';

/**
 * The per-person copilot turn budget on POST /api/v1/ai/copilot/turns, through the real app.
 * The limiter runs on a test monotonic clock; Ollama's HTTP API is scripted (injected fetch).
 */
const URL_PATH = '/api/v1/ai/copilot/turns';
const MODEL = 'qwen2.5:7b';
const LIMIT = 3;
const WINDOW_MS = 60_000;
const QUESTION_SENTINEL = 'RATE-LIMIT-QUESTION-SENTINEL';

// --- Scripted Ollama: each /api/chat takes the next step (default: a plain answer). ----------
type ChatStep = () => Promise<{ status: number; body: unknown }>;
let steps: ChatStep[] = [];
let chatCount = 0;
const respond = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
const ollamaFetch: FetchLike = async (url) => {
  if (url.endsWith('/api/tags')) return respond(200, { models: [{ name: MODEL }] });
  chatCount++;
  const step = steps.shift();
  const r = step
    ? await step()
    : { status: 200, body: { message: { role: 'assistant', content: 'An answer.' } } };
  return respond(r.status, r.body);
};
function gate() {
  let open: () => void = () => undefined;
  const reply = new Promise<{ status: number; body: unknown }>((resolve) => {
    open = () =>
      resolve({ status: 200, body: { message: { role: 'assistant', content: 'held' } } });
  });
  return { step: () => reply, open: () => open() };
}

// --- A test monotonic clock for the limiter. ---------------------------------------------------
let monotonic = 1_000;
const limiter = createRateLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
  maxKeys: 50,
  now: () => monotonic,
});

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
    copilotRateLimiter: limiter,
    logger,
  });
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' });
  for (const fx of [A, B]) {
    await env.services.commands.execute(
      setAiPolicy,
      {
        expectedVersion: 0,
        aiEnabled: true,
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
  app = await buildApp(env.services);
});
afterAll(async () => {
  await app.close();
  await env.destroy();
});
beforeEach(() => {
  steps = [];
  chatCount = 0;
  // Each test starts in a fresh window for everyone.
  monotonic += 10 * WINDOW_MS;
});

async function signIn(actor: AuthenticatedActor) {
  const { token } = await createSession(env.services.db, {
    userId: actor.user.id,
    companyId: actor.user.companyId,
    ttlHours: 1,
    now: new Date(),
    ip: null,
    userAgent: 'copilot rate limit test',
  });
  return `ferp_session=${token}`;
}
const turn = (cookie: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: URL_PATH,
    headers: cookie ? { cookie } : {},
    payload: payload as Record<string, unknown>,
  });
const ask = { question: `${QUESTION_SENTINEL} Who are our customers?` };
const code = (res: { json: () => unknown }) => (res.json() as ProblemDetails).code;

describe('per-person turn budget', () => {
  it('repeated sequential turns: the limit-th + 1 gets 429 AI_RATE_LIMITED with Retry-After, and no model call', async () => {
    const cookie = await signIn(A.actors.owner);
    for (let i = 0; i < LIMIT; i++) {
      const ok = await turn(cookie, ask);
      expect(ok.statusCode, `turn ${i + 1}`).toBe(200);
      expect(ok.json<CopilotTurnResponse>().answer).toBe('An answer.');
      monotonic += 1_000;
    }
    expect(chatCount).toBe(LIMIT);

    const limited = await turn(cookie, ask);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json<ProblemDetails>()).toMatchObject({
      code: 'AI_RATE_LIMITED',
      title:
        'You have asked the AI assistant many questions in a short time. Please wait before asking again.',
    });
    // The first turn leaves the window 60 s after it started; 3 s have passed since.
    expect(limited.headers['retry-after']).toBe('57');
    expect(chatCount).toBe(LIMIT);
    expect(env.services.copilot.activeTurns()).toBe(0); // it never took a concurrency permit

    monotonic += 57_000;
    expect((await turn(cookie, ask)).statusCode).toBe(200);
  });

  it('is per person and per company: the identity comes from the session, never the body', async () => {
    const owner = await signIn(A.actors.owner);
    for (let i = 0; i < LIMIT; i++) expect((await turn(owner, ask)).statusCode).toBe(200);
    expect(code(await turn(owner, ask))).toBe('AI_RATE_LIMITED');

    // Someone else in the same company, and the same role in another company, are unaffected.
    expect((await turn(await signIn(A.actors.accountant), ask)).statusCode).toBe(200);
    expect((await turn(await signIn(B.actors.owner), ask)).statusCode).toBe(200);

    // Naming another person in the body changes nothing: it is refused as invalid (400),
    // before the budget is consulted, and the limited person stays limited.
    const accountant = await signIn(A.actors.accountant);
    const spoof = await turn(owner, { ...ask, userId: A.actors.accountant.user.id });
    expect(spoof.statusCode).toBe(400);
    expect(code(await turn(owner, ask))).toBe('AI_RATE_LIMITED');
    expect((await turn(accountant, ask)).statusCode).toBe(200);
  });

  it('invalid, unauthenticated and refused requests consume nothing and run no model call', async () => {
    const cookie = await signIn(A.actors.owner);
    for (let i = 0; i < 2 * LIMIT; i++) {
      expect((await turn(cookie, { question: '' })).statusCode).toBe(400);
      expect((await turn(cookie, { ...ask, companyId: B.companyId })).statusCode).toBe(400);
      expect((await turn(null, ask)).statusCode).toBe(401);
    }
    const worker = A.actors.worker;
    const workerCookie = await signIn(worker);
    await env.ownerDb
      .updateTable('identity.users')
      .set({ mustChangePassword: true })
      .where('id', '=', worker.user.id)
      .execute();
    try {
      for (let i = 0; i < 2 * LIMIT; i++) {
        expect(code(await turn(workerCookie, ask))).toBe('PASSWORD_CHANGE_REQUIRED');
      }
    } finally {
      await env.ownerDb
        .updateTable('identity.users')
        .set({ mustChangePassword: false })
        .where('id', '=', worker.user.id)
        .execute();
    }
    expect(chatCount).toBe(0);
    // The whole budget is still there.
    for (let i = 0; i < LIMIT; i++) expect((await turn(cookie, ask)).statusCode).toBe(200);
    expect((await turn(workerCookie, ask)).statusCode).toBe(200);
  });

  it('interacts with the concurrency limits: a BUSY refusal gives its admission back', async () => {
    const cookie = await signIn(A.actors.admin);
    const held = gate();
    steps = [held.step];
    const running = turn(cookie, ask); // admission 1, holds this person's only permit
    for (let i = 0; i < 50 && chatCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(env.services.copilot.activeTurns()).toBe(1);

    for (let i = 0; i < 2 * LIMIT; i++) {
      const busy = await turn(cookie, ask);
      expect([busy.statusCode, code(busy)]).toEqual([429, 'AI_BUSY']);
      expect(busy.headers['retry-after']).toBe('5');
    }
    held.open();
    expect((await running).statusCode).toBe(200);
    expect(env.services.copilot.activeTurns()).toBe(0);

    // The BUSY refusals cost nothing: LIMIT - 1 more turns fit, then the budget is spent.
    for (let i = 0; i < LIMIT - 1; i++) expect((await turn(cookie, ask)).statusCode).toBe(200);
    const limited = await turn(cookie, ask);
    expect([limited.statusCode, code(limited)]).toEqual([429, 'AI_RATE_LIMITED']);
    expect(env.services.copilot.activeTurns()).toBe(0);
  });

  it('holds one entry per person it has seen, within its bound', () => {
    expect(limiter.size()).toBeGreaterThan(0);
    expect(limiter.size()).toBeLessThanOrEqual(50);
  });

  it('logs the refusal by id only: never the question', () => {
    const lines = logLines.filter((l) => l.includes('copilot turn rate limited'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(Object.keys(JSON.parse(l) as object)).toEqual(
        expect.arrayContaining(['userId', 'companyId']),
      );
    }
    expect(logLines.join('\n')).not.toContain(QUESTION_SENTINEL);
  });
});

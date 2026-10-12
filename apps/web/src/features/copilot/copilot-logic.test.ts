import { COPILOT_TOOLS, PERMISSIONS, type AiStatusDto } from '@factory-erp/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, parseRetryAfter } from '../../lib/api';
import {
  aiReadiness,
  availableLookups,
  copilotCeiling,
  describeCopilotError,
  formatWait,
  lookupLabels,
  suggestedQuestions,
} from './copilot-logic';

const status = (over: Partial<AiStatusDto> = {}): AiStatusDto => ({
  state: 'REACHABLE',
  providerId: 'ollama',
  locality: 'LOCAL',
  reason: null,
  checkedAt: '2026-10-10T10:00:00.000Z',
  policy: { state: 'ENABLED', version: 1 },
  ...over,
});
const problem = (code: string, status: number, retryAfter?: number) =>
  new ApiError(
    { type: 'about:blank', title: 'server title', status, code, requestId: 'req-1' },
    retryAfter,
  );

describe('AI readiness from GET /ai/status', () => {
  it('ready only when the local runtime answers and the company policy is on', () => {
    expect(aiReadiness(status())).toMatchObject({
      kind: 'ready',
      label: 'Local AI ready',
      canAsk: true,
    });
  });

  it('switched off on the server, or by the company policy: asking is disabled', () => {
    expect(
      aiReadiness(status({ state: 'DISABLED', providerId: null, locality: null })),
    ).toMatchObject({ kind: 'off', label: 'AI not set up', canAsk: false });
    for (const state of ['NONE', 'DISABLED'] as const) {
      expect(aiReadiness(status({ policy: { state, version: null } }))).toMatchObject({
        kind: 'off',
        label: 'Off for this company',
        canAsk: false,
      });
    }
    expect(aiReadiness(status({ policy: { state: 'INVALID', version: null } }))).toMatchObject({
      kind: 'off',
      canAsk: false,
    });
  });

  it('a runtime pause leaves asking open; a setup problem closes it', () => {
    const down = aiReadiness(status({ state: 'UNAVAILABLE', reason: 'UNREACHABLE' }));
    expect(down).toMatchObject({ kind: 'unavailable', canAsk: true });
    expect(down.detail).toMatch(/not responding/);
    expect(
      aiReadiness(status({ state: 'UNAVAILABLE', reason: 'MODEL_NOT_INSTALLED' })),
    ).toMatchObject({ canAsk: false });
    const remote = aiReadiness(status({ state: 'UNAVAILABLE', reason: 'MODEL_NOT_LOCAL' }));
    expect(remote).toMatchObject({ canAsk: false });
    expect(remote.detail).toMatch(/refused/);
    expect(aiReadiness(status({ policy: { state: 'UNAVAILABLE', version: null } }))).toMatchObject({
      kind: 'unavailable',
      canAsk: true,
    });
  });

  it('anything but local inference is never "ready"', () => {
    expect(aiReadiness(status({ locality: 'CLOUD' }))).toMatchObject({
      kind: 'unavailable',
      canAsk: false,
    });
  });

  it('while loading, or if the status cannot be read, the server still decides', () => {
    expect(aiReadiness(undefined)).toMatchObject({ kind: 'checking', canAsk: true });
    expect(aiReadiness(undefined, true)).toMatchObject({ kind: 'unknown', canAsk: true });
    expect(aiReadiness(status({ state: 'NOT_CHECKED' }))).toMatchObject({ kind: 'checking' });
  });

  it('never shows provider, model or runtime details', () => {
    const texts = [
      status(),
      status({ state: 'UNAVAILABLE', reason: 'UNREACHABLE' }),
      status({ state: 'DISABLED' }),
    ].map((s) => JSON.stringify(aiReadiness(s)));
    for (const t of texts) expect(t).not.toMatch(/ollama|qwen|11434|http/i);
  });
});

describe('lookups and suggested questions', () => {
  const ALL = Object.values(PERMISSIONS);

  it('a person with every permission and a CONFIDENTIAL ceiling gets all five lookups', () => {
    expect(availableLookups(ALL, 'CONFIDENTIAL').map((t) => t.name)).toEqual(
      COPILOT_TOOLS.map((t) => t.name),
    );
    expect(suggestedQuestions(ALL, 'CONFIDENTIAL')).toHaveLength(5);
  });

  it('follows the person’s permissions: a stock-only role is offered stock questions only', () => {
    const stockOnly = [PERMISSIONS.companyRead, PERMISSIONS.inventoryStockRead];
    expect(availableLookups(stockOnly, null).map((t) => t.name)).toEqual([
      'inventory.stock.list',
      'inventory.warehouses.list',
    ]);
    expect(suggestedQuestions([PERMISSIONS.companyRead], null)).toEqual([]);
  });

  it('follows the company policy’s data ceiling: INTERNAL excludes the CONFIDENTIAL lookups', () => {
    expect(availableLookups(ALL, 'INTERNAL').map((t) => t.dataClass)).toEqual([
      'INTERNAL',
      'INTERNAL',
    ]);
    expect(availableLookups(ALL, 'PUBLIC')).toEqual([]);
  });

  it('reads the ceiling of the copilot task from the policy view', () => {
    expect(copilotCeiling(null)).toBeNull();
    expect(
      copilotCeiling({
        version: 2,
        aiEnabled: true,
        locality: 'LOCAL_ONLY',
        cloudEnabled: false,
        updatedAt: '2026-10-10T00:00:00Z',
        valid: true,
        tasks: [{ task: 'copilot.answer', maxDataClass: 'INTERNAL' }],
        detail: null,
      }),
    ).toBe('INTERNAL');
  });

  it('labels lookups an answer used, linking each to the ERP page to check it', () => {
    expect(lookupLabels(['finance.receivables.summary', 'inventory.warehouses.list'])).toEqual([
      {
        name: 'finance.receivables.summary',
        label: 'Receivables summary',
        page: '/finance/receivables',
      },
      { name: 'inventory.warehouses.list', label: 'Warehouses', page: '/inventory/stock' },
    ]);
    // A name this client does not know is shown as given, without a link.
    expect(lookupLabels(['something.new'])).toEqual([
      { name: 'something.new', label: 'something.new', page: null },
    ]);
  });
});

describe('copilot failures', () => {
  const cases: [string, number, RegExp, boolean][] = [
    ['AI_DISABLED', 503, /not set up/, false],
    ['AI_POLICY_BLOCKED', 403, /AI policy/, false],
    ['AI_UNAVAILABLE', 503, /unavailable/, true],
    ['AI_TIMEOUT', 504, /too long/, true],
    ['AI_BUSY', 429, /busy/, true],
    ['AI_RATE_LIMITED', 429, /Too many questions/, true],
    ['AI_NO_ANSWER', 422, /No answer/, true],
    ['AI_AUTHORIZATION_CHANGED', 409, /access changed/, true],
    ['UNAUTHENTICATED', 401, /session has ended/, false],
    ['PASSWORD_CHANGE_REQUIRED', 403, /new password/, false],
    ['FORBIDDEN', 403, /role/, false],
    ['VALIDATION_FAILED', 400, /cannot be sent/, false],
    ['DATABASE_UNAVAILABLE', 503, /busy/, true],
  ];
  it.each(cases)('%s (%i): a fixed, plain message', (code, httpStatus, title, canRetry) => {
    const n = describeCopilotError(problem(code, httpStatus));
    expect(n.code).toBe(code);
    expect(n.title).toMatch(title);
    expect(n.canRetry).toBe(canRetry);
    // The page writes its own words; the server's title is never shown verbatim.
    expect(`${n.title} ${n.body}`).not.toContain('server title');
  });

  it('busy and rate-limited say when to try again, from Retry-After', () => {
    expect(describeCopilotError(problem('AI_BUSY', 429, 5)).body).toMatch(/about 5 seconds/);
    expect(describeCopilotError(problem('AI_RATE_LIMITED', 429, 57)).body).toMatch(
      /about 57 seconds/,
    );
    expect(describeCopilotError(problem('AI_RATE_LIMITED', 429, 540)).body).toMatch(
      /about 9 minutes/,
    );
  });

  it('a changed access or AI setup refreshes status; a cancel and network failures are distinct', () => {
    expect(describeCopilotError(problem('AI_AUTHORIZATION_CHANGED', 409)).refresh).toBe(true);
    expect(describeCopilotError(problem('AI_POLICY_BLOCKED', 403)).refresh).toBe(true);
    expect(describeCopilotError(new DOMException('aborted', 'AbortError'))).toMatchObject({
      code: 'CANCELLED',
      title: 'Cancelled',
    });
    expect(describeCopilotError(new TypeError('Failed to fetch'))).toMatchObject({
      code: 'NETWORK',
      canRetry: true,
    });
  });

  it('an unknown failure gives the reference to quote, nothing else', () => {
    const n = describeCopilotError(problem('INTERNAL_ERROR', 500));
    expect(n).toMatchObject({ title: 'Something went wrong', canRetry: true });
    expect(n.body).toContain('req-1');
  });
});

describe('waits and Retry-After', () => {
  it('formats waits in seconds or minutes', () => {
    expect(formatWait(1)).toBe('about 1 second');
    expect(formatWait(59)).toBe('about 59 seconds');
    expect(formatWait(60)).toBe('about 1 minute');
    expect(formatWait(61)).toBe('about 2 minutes');
  });

  it('accepts only delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(' 57 ')).toBe(57);
    for (const v of [null, '', 'soon', '-1', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      expect(parseRetryAfter(v)).toBeUndefined();
    }
  });
});

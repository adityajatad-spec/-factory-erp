import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config';
import { addDays, businessDate } from './clock';
import { uuidv7 } from './ids';
import { canonicalJson } from './json';

describe('businessDate (IST)', () => {
  it('rolls over at midnight IST, not UTC', () => {
    expect(businessDate(new Date('2026-03-31T18:29:59Z'))).toBe('2026-03-31'); // 23:59:59 IST
    expect(businessDate(new Date('2026-03-31T18:30:00Z'))).toBe('2026-04-01'); // 00:00 IST — new financial year
  });

  it('adds days without timezone drift', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 UUIDs that sort by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }),
    );
  });
});

describe('loadConfig — local AI', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
  const issues = (env: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...env });
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('is off unless explicitly configured, with bounded defaults', () => {
    expect(loadConfig(base).ai).toEqual({
      provider: 'none',
      ollamaUrl: 'http://127.0.0.1:11434',
      model: null,
      contextTokens: 8192,
      timeoutMs: 120_000,
      healthTimeoutMs: 2000,
    });
  });

  it('accepts an Ollama configuration naming an installed model', () => {
    expect(
      loadConfig({
        ...base,
        AI_PROVIDER: 'ollama',
        AI_MODEL: 'qwen2.5:7b',
        OLLAMA_URL: 'http://192.168.1.20:11434',
        AI_TIMEOUT_MS: '60000',
      }).ai,
    ).toMatchObject({ provider: 'ollama', model: 'qwen2.5:7b', timeoutMs: 60_000 });
  });

  it('refuses incomplete or unsafe settings, naming the variable but never the value', () => {
    expect(issues({ AI_PROVIDER: 'ollama' })).toMatch(/AI_MODEL: is required/);
    expect(issues({ AI_PROVIDER: 'openai' })).toMatch(/AI_PROVIDER/);
    expect(issues({ OLLAMA_URL: 'ftp://host' })).toMatch(/OLLAMA_URL/);
    const withSecret = issues({ OLLAMA_URL: 'http://admin:hunter2@host:11434' });
    expect(withSecret).toMatch(/OLLAMA_URL: must be an http/);
    expect(withSecret).not.toContain('hunter2');
    expect(issues({ AI_MODEL: 'bad model; rm -rf' })).toMatch(/AI_MODEL/);
    expect(issues({ AI_TIMEOUT_MS: '10' })).toMatch(/AI_TIMEOUT_MS/);
    expect(issues({ AI_HEALTH_TIMEOUT_MS: '60000' })).toMatch(/AI_HEALTH_TIMEOUT_MS/);
    expect(issues({ NODE_ENV: 'production', COOKIE_SECURE: 'true', AI_PROVIDER: 'fake' })).toMatch(
      /AI_PROVIDER: fake is for tests/,
    );
  });

  it('the pooled-connection wait defaults to 10 s and is bounded when configured', () => {
    expect(loadConfig(base).databasePoolAcquireTimeoutMs).toBe(10_000);
    expect(
      loadConfig({ ...base, DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '2500' })
        .databasePoolAcquireTimeoutMs,
    ).toBe(2_500);
    // 0 would mean "wait forever" to pg-pool: refused.
    expect(issues({ DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '0' })).toMatch(
      /DATABASE_POOL_ACQUIRE_TIMEOUT_MS/,
    );
  });

  it('the copilot turn budget defaults to 20 per 10 minutes and is bounded when configured', () => {
    expect(loadConfig(base).copilotRateLimit).toEqual({ turns: 20, windowMs: 600_000 });
    expect(
      loadConfig({
        ...base,
        COPILOT_RATE_LIMIT_TURNS: '5',
        COPILOT_RATE_LIMIT_WINDOW_SECONDS: '60',
      }).copilotRateLimit,
    ).toEqual({ turns: 5, windowMs: 60_000 });
    expect(issues({ COPILOT_RATE_LIMIT_TURNS: '0' })).toMatch(/COPILOT_RATE_LIMIT_TURNS/);
    expect(issues({ COPILOT_RATE_LIMIT_TURNS: '5000' })).toMatch(/COPILOT_RATE_LIMIT_TURNS/);
    expect(issues({ COPILOT_RATE_LIMIT_WINDOW_SECONDS: '1' })).toMatch(
      /COPILOT_RATE_LIMIT_WINDOW_SECONDS/,
    );
  });

  it('refuses Ollama cloud models (they would run on a remote service)', () => {
    for (const m of ['gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'some-model:cloud']) {
      expect(issues({ AI_PROVIDER: 'ollama', AI_MODEL: m }), m).toMatch(/AI_MODEL/);
    }
    expect(loadConfig({ ...base, AI_PROVIDER: 'ollama', AI_MODEL: 'qwen2.5:7b' }).ai.model).toBe(
      'qwen2.5:7b',
    );
  });

  it('accepts the fake provider only when NODE_ENV is explicitly development or test', () => {
    // NODE_ENV unset (base has none): refused, although the default is "development".
    expect(issues({ AI_PROVIDER: 'fake' })).toMatch(
      /AI_PROVIDER: fake requires NODE_ENV to be set explicitly/,
    );
    expect(loadConfig({ ...base, NODE_ENV: 'development', AI_PROVIDER: 'fake' }).ai.provider).toBe(
      'fake',
    );
    expect(loadConfig({ ...base, NODE_ENV: 'test', AI_PROVIDER: 'fake' }).ai.provider).toBe('fake');
    expect(issues({ NODE_ENV: 'production', COOKIE_SECURE: 'true', AI_PROVIDER: 'fake' })).toMatch(
      /AI_PROVIDER/,
    );
    // Unaffected: AI off, or a real local runtime, with NODE_ENV unset.
    expect(loadConfig(base).ai.provider).toBe('none');
    expect(loadConfig({ ...base, AI_PROVIDER: 'ollama', AI_MODEL: 'qwen2.5:7b' }).ai.provider).toBe(
      'ollama',
    );
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      env: 'development',
      port: 3000,
      cookieSecure: false,
      sessionTtlHours: 12,
    });
  });

  it('lists every problem and never echoes values', () => {
    try {
      loadConfig({ DATABASE_URL: 'mysql://secret-password@host', PORT: 'abc' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('DATABASE_URL');
      expect((e as Error).message).toContain('PORT');
      expect((e as Error).message).not.toContain('secret-password');
    }
  });

  it('requires secure cookies in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' }).cookieSecure,
    ).toBe(true);
  });

  it('never gives the production server the schema-owner credentials', () => {
    const owner = { DATABASE_OWNER_URL: 'postgres://owner:p@localhost:5432/db' };
    expect(() =>
      loadConfig({ ...base, ...owner, NODE_ENV: 'production', COOKIE_SECURE: 'true' }),
    ).toThrow(/DATABASE_OWNER_URL/);
    expect(loadConfig({ ...base, ...owner }).databaseOwnerUrl).toBe(owner.DATABASE_OWNER_URL);
  });
});

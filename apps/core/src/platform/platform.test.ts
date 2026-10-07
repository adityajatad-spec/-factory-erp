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
});

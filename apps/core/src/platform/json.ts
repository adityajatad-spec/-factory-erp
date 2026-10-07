import { createHash } from 'node:crypto';

/**
 * Serialise a value for a jsonb parameter. Always stringify explicitly: node-postgres would
 * otherwise turn JS arrays into PostgreSQL array literals.
 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value);
}

/** Deterministic JSON (sorted object keys) — used to fingerprint requests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

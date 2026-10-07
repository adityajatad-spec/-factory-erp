import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp + random bits. Generated in the application so
 * the schema does not depend on any particular PostgreSQL version, and so offline clients can
 * create IDs later.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id password hashing via Node's built-in crypto.argon2 (Node >= 24.7; no native
 * add-on). Parameters follow the OWASP baseline (19 MiB, t=2, p=1) — modest enough for a
 * small factory server. Hashes are stored in PHC string format so parameters can be raised
 * later without breaking existing hashes.
 */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const SALT_BYTES = 16;

function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, ...params }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const [, memory, passes, parallelism, saltB64, hashB64] = m;
  const expected = Buffer.from(hashB64 ?? '', 'base64');
  const actual = await derive(password, Buffer.from(saltB64 ?? '', 'base64'), {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A valid hash of a random password — verified against when a username does not exist so
 * that response time does not reveal which usernames are real. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

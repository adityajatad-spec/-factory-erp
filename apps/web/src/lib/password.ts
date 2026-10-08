/**
 * A readable temporary password, e.g. "k7mq-x2vp-9wrt-h3cd": 16 characters from an alphabet
 * without look-alikes (no 0/o, 1/l/i), from the browser's cryptographic random source.
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

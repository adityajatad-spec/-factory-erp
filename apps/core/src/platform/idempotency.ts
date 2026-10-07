import type { DbTransaction } from '../db/database';
import { IdempotencyKeyReusedError } from './errors';
import { toJsonb } from './json';

export type IdempotencyClaim = { kind: 'claimed' } | { kind: 'replay'; response: unknown };

/**
 * Claim an idempotency key inside the command's transaction.
 *
 * A concurrent request with the same key blocks on the primary key until the first
 * transaction finishes; it then sees the stored response (replay) or — if the first one
 * rolled back — claims the key itself. Reusing a key for a different request is rejected.
 */
export async function claimIdempotencyKey(
  tx: DbTransaction,
  args: { userId: string; key: string; command: string; requestHash: string },
): Promise<IdempotencyClaim> {
  const inserted = await tx
    .insertInto('system.idempotencyKeys')
    .values({
      userId: args.userId,
      key: args.key,
      command: args.command,
      requestHash: args.requestHash,
    })
    .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (inserted) return { kind: 'claimed' };

  const existing = await tx
    .selectFrom('system.idempotencyKeys')
    .select(['command', 'requestHash', 'response'])
    .where('userId', '=', args.userId)
    .where('key', '=', args.key)
    .executeTakeFirstOrThrow();

  if (
    existing.command !== args.command ||
    existing.requestHash !== args.requestHash ||
    existing.response === null
  ) {
    throw new IdempotencyKeyReusedError();
  }
  return { kind: 'replay', response: existing.response };
}

export async function storeIdempotentResponse(
  tx: DbTransaction,
  args: { userId: string; key: string; response: unknown },
): Promise<void> {
  await tx
    .updateTable('system.idempotencyKeys')
    .set({ response: toJsonb(args.response ?? null) })
    .where('userId', '=', args.userId)
    .where('key', '=', args.key)
    .execute();
}

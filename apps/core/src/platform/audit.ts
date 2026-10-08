import type { DbTransaction } from '../db/database';
import type { Actor } from './actor';
import { uuidv7 } from './ids';
import { toJsonb } from './json';

export interface AuditRecord {
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

/** Append audit events in the caller's transaction (audit.events is append-only in SQL). */
export async function writeAudit(
  tx: DbTransaction,
  records: readonly AuditRecord[],
  meta: {
    /** Usually signed in; an anonymous actor only for failed sign-ins of a known user. */
    actor: Actor;
    command: string;
    companyId: string;
    occurredAt: Date;
  },
): Promise<void> {
  if (records.length === 0) return;
  const { actor } = meta;
  const aiSessionId = actor.actorKind === 'ai_agent' ? (actor.aiSessionId ?? null) : null;
  const json = (v: unknown) => (v === undefined ? null : toJsonb(v));
  await tx
    .insertInto('audit.events')
    .values(
      records.map((r) => ({
        id: uuidv7(meta.occurredAt.getTime()),
        occurredAt: meta.occurredAt,
        companyId: meta.companyId,
        actorUserId: actor.user?.id ?? null,
        actorKind: actor.actorKind,
        aiSessionId,
        requestId: actor.requestId,
        command: meta.command,
        entityType: r.entityType,
        entityId: r.entityId,
        before: json(r.before),
        after: json(r.after),
        metadata: json(r.metadata),
      })),
    )
    .execute();
}

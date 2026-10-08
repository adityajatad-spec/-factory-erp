import { z } from 'zod';
import { Uuid } from './common';

/** Background jobs (the transactional outbox): PDFs today; notifications and exports later. */
export const OUTBOX_STATUSES = ['PENDING', 'DONE', 'FAILED'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const ListOutboxQuery = z.object({
  status: z.enum(['FAILED', 'PENDING']).default('FAILED'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOutboxQuery = z.input<typeof ListOutboxQuery>;

export const RetryOutboxEventRequest = z.object({ eventId: Uuid });
export type RetryOutboxEventRequest = z.input<typeof RetryOutboxEventRequest>;

export interface OutboxEventDto {
  id: string;
  topic: string;
  /** What the job is about, e.g. "sales.invoice" + its id. */
  aggregateType: string;
  aggregateId: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  occurredAt: string;
  availableAt: string;
  failedAt: string | null;
}

export interface OutboxOverviewDto {
  failed: number;
  pending: number;
  events: OutboxEventDto[];
}

import type { OutboxEventDto, OutboxStatus } from '@factory-erp/contracts';
import type { OutboxEvent } from '../../platform/outbox';

export function toOutboxEventDto(e: OutboxEvent): OutboxEventDto {
  return {
    id: e.id,
    topic: e.topic,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    status: e.status as OutboxStatus,
    attempts: e.attempts,
    lastError: e.lastError,
    occurredAt: e.occurredAt.toISOString(),
    availableAt: e.availableAt.toISOString(),
    failedAt: e.failedAt ? e.failedAt.toISOString() : null,
  };
}

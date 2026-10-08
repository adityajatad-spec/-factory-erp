import { PERMISSIONS, RetryOutboxEventRequest } from '@factory-erp/contracts';
import { defineCommand } from '../../platform/commands';
import { requeueFailedEvent } from '../../platform/outbox';
import { toOutboxEventDto } from './dto';

export const retryOutboxEvent = defineCommand({
  name: 'operations.outbox.retry',
  description:
    'Retry a failed background job (for example a PDF that could not be rendered) after fixing its cause.',
  input: RetryOutboxEventRequest,
  permission: PERMISSIONS.outboxManage,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, companyId, now }, input) => {
    const { before, after } = await requeueFailedEvent(tx, {
      companyId,
      eventId: input.eventId,
      now,
    });
    return {
      result: toOutboxEventDto(after),
      audit: [
        {
          entityType: 'system.outbox_event',
          entityId: before.id,
          before: { status: before.status, attempts: before.attempts, lastError: before.lastError },
          after: { status: after.status, attempts: after.attempts },
          metadata: { topic: before.topic, aggregateId: before.aggregateId },
        },
      ],
    };
  },
});

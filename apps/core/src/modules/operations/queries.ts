import { ListOutboxQuery, PERMISSIONS, type OutboxOverviewDto } from '@factory-erp/contracts';
import { defineQuery } from '../../platform/queries';
import { toOutboxEventDto } from './dto';

export const listOutboxEvents = defineQuery({
  name: 'operations.outbox.list',
  description: 'Background jobs of this company that failed or are still waiting, with counts.',
  input: ListOutboxQuery,
  permission: PERMISSIONS.outboxManage,
  ai: { tier: 'FORBIDDEN' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId }, input): Promise<OutboxOverviewDto> => {
    const counts = await db
      .selectFrom('system.outboxEvents')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('companyId', '=', companyId)
      .where('status', 'in', ['FAILED', 'PENDING'])
      .groupBy('status')
      .execute();
    const events = await db
      .selectFrom('system.outboxEvents')
      .selectAll()
      .where('companyId', '=', companyId)
      .where('status', '=', input.status)
      .orderBy('occurredAt', 'desc')
      .limit(input.limit)
      .execute();
    const count = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    return {
      failed: count('FAILED'),
      pending: count('PENDING'),
      events: events.map(toOutboxEventDto),
    };
  },
});

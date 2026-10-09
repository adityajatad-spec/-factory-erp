import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { defineKpi, type KpiDefinition } from '../../platform/insights';

export const purchasingKpis: readonly KpiDefinition[] = [
  defineKpi({
    id: 'purchase.open_orders',
    label: 'Open purchase orders',
    unit: 'COUNT',
    definition: 'Approved purchase orders still expecting goods (approved or partly received).',
    permission: PERMISSIONS.purchaseOrderRead,
    compute: async ({ db, companyId }) => {
      const r = await db
        .selectFrom('purchase.orders')
        .select(sql<string>`count(*)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', 'in', ['APPROVED', 'PARTIALLY_RECEIVED'])
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'purchase.overdue_orders',
    label: 'Overdue purchase orders',
    unit: 'COUNT',
    definition:
      'Open purchase orders whose expected delivery date has passed with goods still to come.',
    permission: PERMISSIONS.purchaseOrderRead,
    compute: async ({ db, companyId, businessDate }) => {
      const r = await db
        .selectFrom('purchase.orders')
        .select(sql<string>`count(*)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', 'in', ['APPROVED', 'PARTIALLY_RECEIVED'])
        .where('expectedDate', '<', businessDate)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
];

import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { defineKpi, type KpiDefinition } from '../analytics/insights';

export const receivablesKpis: readonly KpiDefinition[] = [
  defineKpi({
    id: 'finance.collections_this_month',
    label: 'Collections this month',
    unit: 'INR',
    definition: 'Total of customer receipts dated in the current calendar month (IST).',
    permission: PERMISSIONS.receivablesRead,
    compute: async ({ db, companyId, businessDate }) => {
      const monthStart = `${businessDate.slice(0, 7)}-01`;
      const r = await db
        .selectFrom('finance.receipts')
        .select(sql<string>`coalesce(sum(amount), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('receiptDate', '>=', monthStart)
        .where('receiptDate', '<=', businessDate)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'finance.receivables_overdue_60',
    label: 'Outstanding > 60 days',
    unit: 'INR',
    definition:
      'Outstanding on issued invoices more than 60 days old (by invoice date), after payment allocations and credit notes. Cancelled invoices are excluded.',
    permission: PERMISSIONS.receivablesRead,
    compute: async ({ db, companyId, businessDate }) => {
      const r = await db
        .selectFrom('finance.invoiceBalances')
        .select(sql<string>`coalesce(sum(outstanding_amount), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where(sql<boolean>`invoice_date < (${businessDate}::date - 60)`)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
];

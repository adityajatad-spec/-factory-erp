import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { defineKpi, type KpiDefinition } from '../analytics/insights';

export const financeKpis: readonly KpiDefinition[] = [
  defineKpi({
    id: 'finance.receivables_outstanding',
    label: 'Outstanding receivables',
    unit: 'INR',
    definition:
      'What customers owe, from the customer balance ledger: issued invoices minus cancellations, credit notes and receipts. Money held on account (customer credit) reduces it.',
    permission: PERMISSIONS.receivablesRead,
    compute: async ({ db, companyId }) => {
      const r = await db
        .selectFrom('finance.partyLedgerEntries')
        .select(sql<string>`coalesce(sum(debit - credit), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
];

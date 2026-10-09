import { PERMISSIONS } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { defineKpi, type KpiDefinition } from '../../platform/insights';

export const payablesKpis: readonly KpiDefinition[] = [
  defineKpi({
    id: 'finance.payables_outstanding',
    label: 'Owed to suppliers',
    unit: 'INR',
    definition:
      'What we owe suppliers, from the supplier payable ledger: posted purchase invoices minus approved supplier payments. Payments awaiting approval are not deducted.',
    permission: PERMISSIONS.payablesRead,
    compute: async ({ db, companyId }) => {
      const r = await db
        .selectFrom('finance.payableLedgerEntries')
        .select(sql<string>`coalesce(sum(credit - debit), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'finance.payables_overdue',
    label: 'Supplier bills overdue',
    unit: 'INR',
    definition:
      'Outstanding on posted purchase invoices whose due date (bill date + supplier credit days) has passed, after payment allocations.',
    permission: PERMISSIONS.payablesRead,
    compute: async ({ db, companyId, businessDate }) => {
      const r = await db
        .selectFrom('finance.purchaseInvoiceBalances')
        .select(sql<string>`coalesce(sum(outstanding_amount), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('dueDate', '<', businessDate)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'finance.payables_due_this_week',
    label: 'Due to suppliers this week',
    unit: 'INR',
    definition:
      'Outstanding on posted purchase invoices falling due in the next 7 days, today included (not yet overdue).',
    permission: PERMISSIONS.payablesRead,
    compute: async ({ db, companyId, businessDate }) => {
      const r = await db
        .selectFrom('finance.purchaseInvoiceBalances')
        .select(sql<string>`coalesce(sum(outstanding_amount), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('dueDate', '>=', businessDate)
        .where(sql<boolean>`due_date < (${businessDate}::date + 7)`)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
];

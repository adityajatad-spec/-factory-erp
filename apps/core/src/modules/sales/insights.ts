import { PERMISSIONS } from '@factory-erp/contracts';
import { financialYearOf } from '@factory-erp/gst';
import { sql } from 'kysely';
import { defineKpi, type KpiDefinition } from '../analytics/insights';

export const salesKpis: readonly KpiDefinition[] = [
  defineKpi({
    id: 'sales.today',
    label: "Today's sales",
    unit: 'INR',
    definition:
      'Grand total of invoices issued with today’s invoice date (IST), including GST. Cancelled invoices are excluded; credit notes are not deducted.',
    permission: PERMISSIONS.salesInvoiceRead,
    compute: async ({ db, companyId, businessDate }) => {
      const r = await db
        .selectFrom('sales.invoices')
        .select(sql<string>`coalesce(sum(grand_total), 0)::numeric(18,2)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', '=', 'ISSUED')
        .where('invoiceDate', '=', businessDate)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'sales.fy_to_date',
    label: 'Net sales this financial year',
    unit: 'INR',
    definition:
      'Invoices issued in the current financial year (April–March) minus credit notes issued in it, including GST. Cancelled invoices are excluded.',
    permission: PERMISSIONS.salesInvoiceRead,
    compute: async ({ db, companyId, businessDate }) => {
      const fy = financialYearOf(businessDate);
      const invoiced = db
        .selectFrom('sales.invoices')
        .select(sql<string>`coalesce(sum(grand_total), 0)`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', '=', 'ISSUED')
        .where('invoiceDate', '>=', fy.startDate)
        .where('invoiceDate', '<=', fy.endDate);
      const credited = db
        .selectFrom('sales.creditNotes')
        .select(sql<string>`coalesce(sum(grand_total), 0)`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', '=', 'ISSUED')
        .where('creditNoteDate', '>=', fy.startDate)
        .where('creditNoteDate', '<=', fy.endDate);
      const r = await db
        .selectNoFrom(sql<string>`((${invoiced}) - (${credited}))::numeric(18,2)::text`.as('v'))
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'sales.invoices_this_month',
    label: 'Invoices issued this month',
    unit: 'COUNT',
    definition:
      'Number of invoices issued with an invoice date in the current calendar month (IST). Cancelled invoices are excluded.',
    permission: PERMISSIONS.salesInvoiceRead,
    compute: async ({ db, companyId, businessDate }) => {
      const monthStart = `${businessDate.slice(0, 7)}-01`;
      const r = await db
        .selectFrom('sales.invoices')
        .select(sql<string>`count(*)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', '=', 'ISSUED')
        .where('invoiceDate', '>=', monthStart)
        .where('invoiceDate', '<=', businessDate)
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
  defineKpi({
    id: 'sales.drafts_open',
    label: 'Draft invoices',
    unit: 'COUNT',
    definition: 'Invoices saved as drafts and not yet issued.',
    permission: PERMISSIONS.salesInvoiceRead,
    compute: async ({ db, companyId }) => {
      const r = await db
        .selectFrom('sales.invoices')
        .select(sql<string>`count(*)::text`.as('v'))
        .where('companyId', '=', companyId)
        .where('status', '=', 'DRAFT')
        .executeTakeFirstOrThrow();
      return r.v;
    },
  }),
];

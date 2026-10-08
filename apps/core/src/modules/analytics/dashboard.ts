import { PERMISSIONS, type DashboardDto } from '@factory-erp/contracts';
import { z } from 'zod';
import { businessDate } from '../../platform/clock';
import { defineQuery } from '../../platform/queries';
import { financeKpis } from '../finance';
import { receivablesKpis } from '../receivables';
import { salesKpis, selectInvoiceList, toInvoiceListItem } from '../sales';
import type { KpiDefinition } from '../../platform/insights';

const DISPLAY_ORDER = [
  'sales.today',
  'finance.receivables_outstanding',
  'finance.collections_this_month',
  'finance.receivables_overdue_60',
  'sales.invoices_this_month',
  'sales.fy_to_date',
  'sales.drafts_open',
];

const rank = (id: string) => {
  const i = DISPLAY_ORDER.indexOf(id);
  return i === -1 ? DISPLAY_ORDER.length : i;
};

/** Registered KPIs, in display order. Modules contribute; the dashboard only composes. */
export const KPI_REGISTRY: readonly KpiDefinition[] = [
  ...salesKpis,
  ...financeKpis,
  ...receivablesKpis,
].sort((a, b) => rank(a.id) - rank(b.id));

export const getDashboard = defineQuery({
  name: 'dashboard.get',
  description: 'Owner dashboard: KPIs the viewer may see, plus recent invoices.',
  input: z.object({}),
  // Any signed-in user may open the dashboard; each KPI enforces its own permission.
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: async ({ db, companyId, now, can }): Promise<DashboardDto> => {
    const date = businessDate(now);
    const visible = KPI_REGISTRY.filter((k) => can(k.permission));
    const values = await Promise.all(
      visible.map((k) => k.compute({ db, companyId, businessDate: date })),
    );

    const recentInvoices = can(PERMISSIONS.salesInvoiceRead)
      ? (
          await selectInvoiceList(db, companyId).orderBy('inv.updatedAt', 'desc').limit(8).execute()
        ).map(toInvoiceListItem)
      : null;

    return {
      businessDate: date,
      kpis: visible.map((k, i) => ({
        id: k.id,
        label: k.label,
        unit: k.unit,
        definition: k.definition,
        value: values[i] ?? '0',
      })),
      recentInvoices,
    };
  },
});

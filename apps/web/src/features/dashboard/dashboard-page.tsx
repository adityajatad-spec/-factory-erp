import { PERMISSIONS, type DashboardDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/button';
import { EmptyState, ErrorBanner, PageHeader, Panel, Spinner } from '../../components/display';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date, inr, num } from '../../lib/format';
import { useCan, useSession } from '../../lib/session';
import { InvoiceTable } from '../invoices/invoice-table';

export function DashboardPage() {
  const session = useSession();
  const can = useCan();
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardDto>('/dashboard'),
    refetchInterval: 60_000,
  });

  return (
    <>
      <PageHeader
        title={`Good day, ${session.displayName.split(' ')[0] ?? ''}`}
        subtitle={
          dashboard.data
            ? `Business date ${date(dashboard.data.businessDate)} · figures computed live from posted records`
            : undefined
        }
        actions={
          can(PERMISSIONS.salesInvoiceDraft) && (
            <Link to="/sales/invoices/new">
              <Button variant="primary">
                <IconPlus /> New invoice
              </Button>
            </Link>
          )
        }
      />
      <ErrorBanner error={dashboard.error} className="mb-4" />
      {dashboard.isPending && <Spinner />}

      {dashboard.data && (
        <>
          {dashboard.data.kpis.length > 0 ? (
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              {dashboard.data.kpis.map((k) => (
                <div
                  key={k.id}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-3"
                  title={k.definition}
                >
                  <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                    {k.label}
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-900 tabular">
                    {k.unit === 'INR' ? inr(k.value) : num(k.value, 0)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <Panel className="mb-4">
              <EmptyState title="No dashboard metrics for your role yet">
                Modules for production, maintenance and the shop floor will add metrics here as they
                are built.
              </EmptyState>
            </Panel>
          )}

          {dashboard.data.recentInvoices && (
            <Panel
              title="Recent invoices"
              actions={
                <Link
                  to="/sales/invoices"
                  className="text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  View all →
                </Link>
              }
            >
              {dashboard.data.recentInvoices.length === 0 ? (
                <EmptyState title="No invoices yet" />
              ) : (
                <InvoiceTable invoices={dashboard.data.recentInvoices} />
              )}
            </Panel>
          )}
        </>
      )}
    </>
  );
}

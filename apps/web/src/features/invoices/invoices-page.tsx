import { PERMISSIONS, type InvoiceListItemDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { EmptyState, ErrorBanner, PageHeader, Panel, Spinner } from '../../components/display';
import { Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { InvoiceTable } from './invoice-table';

const route = getRouteApi('/app/sales/invoices');
const TABS = [
  { label: 'All', status: undefined, payment: undefined },
  { label: 'Drafts', status: 'DRAFT' as const, payment: undefined },
  { label: 'Issued', status: 'ISSUED' as const, payment: undefined },
  { label: 'Unpaid', status: undefined, payment: 'UNPAID' as const },
  { label: 'Part-paid', status: undefined, payment: 'PARTIALLY_PAID' as const },
  { label: 'Paid', status: undefined, payment: 'PAID' as const },
  { label: 'Credited', status: undefined, payment: 'CREDITED' as const },
  { label: 'Cancelled', status: 'CANCELLED' as const, payment: undefined },
];

export function InvoicesPage() {
  const can = useCan();
  const navigate = useNavigate();
  const search = route.useSearch();
  const [q, setQ] = useState(search.q ?? '');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);

  const invoices = useQuery({
    queryKey: ['invoices', search.status, search.payment, search.customerId, debounced],
    queryFn: () =>
      api.get<InvoiceListItemDto[]>('/sales-invoices', {
        status: search.status,
        paymentStatus: search.payment,
        customerId: search.customerId,
        q: debounced,
        limit: 200,
      }),
  });

  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/sales/invoices/new' }), [navigate]),
    can(PERMISSIONS.salesInvoiceDraft),
  );

  return (
    <>
      <PageHeader
        title="Sales invoices"
        subtitle="GST tax invoices. Drafts can be edited; issued invoices are permanent and are corrected by credit note or cancellation."
        actions={
          can(PERMISSIONS.salesInvoiceDraft) && (
            <Link to="/sales/invoices/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> New invoice
              </Button>
            </Link>
          )
        }
      />
      {search.customerId && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Showing one customer&apos;s invoices.
          <Link
            to="/sales/invoices"
            search={{
              ...(search.status ? { status: search.status } : {}),
              ...(search.payment ? { payment: search.payment } : {}),
            }}
            className="font-medium underline"
          >
            Show all customers
          </Link>
        </div>
      )}
      <Panel
        title={
          <div className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <Link
                key={t.label}
                to="/sales/invoices"
                search={{
                  ...(t.status ? { status: t.status } : {}),
                  ...(t.payment ? { payment: t.payment } : {}),
                  ...(search.customerId ? { customerId: search.customerId } : {}),
                  ...(q ? { q } : {}),
                }}
                className={`rounded px-2 py-1 text-xs font-medium ${search.status === t.status && search.payment === t.payment ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        }
        actions={
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search number or customer  ( / )"
            className="w-56 sm:w-72"
          />
        }
      >
        <ErrorBanner error={invoices.error} className="m-3" />
        {invoices.isPending ? (
          <Spinner />
        ) : invoices.data?.length ? (
          <InvoiceTable invoices={invoices.data} />
        ) : (
          <EmptyState title="No invoices match">
            Try a different filter, or create a new invoice.
          </EmptyState>
        )}
      </Panel>
    </>
  );
}

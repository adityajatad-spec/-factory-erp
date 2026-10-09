import { PERMISSIONS, type PurchaseInvoiceListItemDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
import {
  EmptyState,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { Input, Select } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { MatchBadge, PayableBadge } from './shared';

export function BillsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'DRAFT' | 'POSTED'>('');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const bills = useQuery({
    queryKey: ['bills', debounced, status],
    queryFn: () =>
      api.get<PurchaseInvoiceListItemDto[]>('/purchase-invoices', {
        q: debounced,
        status: status || undefined,
        limit: 200,
      }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/purchasing/bills/new' }), [navigate]),
    can(PERMISSIONS.purchaseInvoiceDraft),
  );
  const open = (id: string) =>
    void navigate({ to: '/purchasing/bills/$invoiceId', params: { invoiceId: id } });

  return (
    <>
      <PageHeader
        title="Supplier bills"
        subtitle="Purchase invoices: entered as drafts, checked against the order and goods received, then posted as owed."
        actions={
          can(PERMISSIONS.purchaseInvoiceDraft) && (
            <Link to="/purchasing/bills/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> Enter bill
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={`${bills.data?.length ?? 0} bills`}
        actions={
          <>
            <Select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="w-32"
            >
              <option value="">All</option>
              <option value="DRAFT">Drafts</option>
              <option value="POSTED">Posted</option>
            </Select>
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search our no., supplier's no., supplier  ( / )"
              className="w-60 sm:w-80"
            />
          </>
        }
      >
        <ErrorBanner error={bills.error} className="m-3" />
        {bills.isPending ? (
          <Spinner />
        ) : bills.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Our no.</th>
                <th className={th}>Supplier bill</th>
                <th className={th}>Bill date</th>
                <th className={th}>Supplier</th>
                <th className={`${th} hidden lg:table-cell`}>PO</th>
                <th className={`${th} hidden md:table-cell`}>Match</th>
                <th className={th}>Due</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={`${th} text-right`}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {bills.data.map((b) => (
                <tr
                  key={b.id}
                  tabIndex={0}
                  onClick={() => open(b.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(b.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium whitespace-nowrap`}>
                    {b.invoiceNumber ?? <span className="text-slate-400">Draft</span>}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{b.supplierInvoiceNumber}</td>
                  <td className={`${td} whitespace-nowrap`}>{date(b.invoiceDate)}</td>
                  <td className={`${td} max-w-56 truncate`}>{b.supplierName}</td>
                  <td className={`${td} hidden font-mono text-xs lg:table-cell`}>
                    {b.poNumber ?? <span className="text-slate-400">Direct</span>}
                  </td>
                  <td className={`${td} hidden md:table-cell`}>
                    <MatchBadge status={b.matchStatus} />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(b.dueDate)}</td>
                  <td className={td}>
                    <PayableBadge status={b.payableStatus} overdue={b.isOverdue} />
                  </td>
                  <td className={`${tdNum} font-medium`}>{inr(b.grandTotal)}</td>
                  <td className={tdNum}>
                    {b.status === 'POSTED' ? inr(b.outstandingAmount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No supplier bills found" />
        )}
      </Panel>
    </>
  );
}

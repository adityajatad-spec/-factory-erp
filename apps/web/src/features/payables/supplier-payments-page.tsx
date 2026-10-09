import {
  PERMISSIONS,
  type SupplierPaymentListItemDto,
  type SupplierPaymentStatus,
} from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
import {
  Badge,
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
import { PAYMENT_MODE_LABELS } from '../receivables/labels';
import { PaymentStatusBadge } from '../purchasing/shared';

export function SupplierPaymentsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | SupplierPaymentStatus>('');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const payments = useQuery({
    queryKey: ['supplier-payments', debounced, status],
    queryFn: () =>
      api.get<SupplierPaymentListItemDto[]>('/supplier-payments', {
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
    useCallback(() => void navigate({ to: '/finance/supplier-payments/new' }), [navigate]),
    can(PERMISSIONS.supplierPaymentRequest),
  );
  const open = (id: string) =>
    void navigate({ to: '/finance/supplier-payments/$paymentId', params: { paymentId: id } });

  return (
    <>
      <PageHeader
        title="Supplier payments"
        subtitle="Recorded by one person, approved by another. Only approved payments reduce what we owe."
        actions={
          can(PERMISSIONS.supplierPaymentRequest) && (
            <Link to="/finance/supplier-payments/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> Record payment
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={`${payments.data?.length ?? 0} payments`}
        actions={
          <>
            <Select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="w-44"
            >
              <option value="">All</option>
              <option value="PENDING_APPROVAL">Awaiting approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </Select>
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search number, supplier, reference  ( / )"
              className="w-56 sm:w-72"
            />
          </>
        }
      >
        <ErrorBanner error={payments.error} className="m-3" />
        {payments.isPending ? (
          <Spinner />
        ) : payments.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Payment</th>
                <th className={th}>Date</th>
                <th className={th}>Supplier</th>
                <th className={`${th} hidden md:table-cell`}>Mode</th>
                <th className={th}>Status</th>
                <th className={`${th} hidden lg:table-cell`}>Recorded / approved by</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={`${th} text-right`}>On account</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr
                  key={p.id}
                  tabIndex={0}
                  onClick={() => open(p.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(p.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium`}>
                    {p.paymentNumber ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(p.paymentDate)}</td>
                  <td className={`${td} max-w-56 truncate`}>{p.supplierName}</td>
                  <td className={`${td} hidden md:table-cell`}>
                    {PAYMENT_MODE_LABELS[p.paymentMode]}
                  </td>
                  <td className={td}>
                    <PaymentStatusBadge status={p.status} />
                  </td>
                  <td className={`${td} hidden text-xs text-slate-600 lg:table-cell`}>
                    {p.requestedByName} / {p.approvedByName ?? '—'}
                  </td>
                  <td className={`${tdNum} font-medium`}>{inr(p.amount)}</td>
                  <td className={tdNum}>
                    {p.unallocatedAmount === '0.00' ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <Badge tone="blue">{inr(p.unallocatedAmount)}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No supplier payments found" />
        )}
      </Panel>
    </>
  );
}

import { PERMISSIONS, type ReceiptListItemDto } from '@factory-erp/contracts';
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
import { Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { PAYMENT_MODE_LABELS } from './labels';

export function ReceiptsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [onlyUnallocated, setOnlyUnallocated] = useState(false);
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);

  const receipts = useQuery({
    queryKey: ['receipts', debounced, onlyUnallocated],
    queryFn: () =>
      api.get<ReceiptListItemDto[]>('/receipts', {
        q: debounced,
        onlyUnallocated: onlyUnallocated ? 'true' : undefined,
        limit: 200,
      }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/finance/receipts/new' }), [navigate]),
    can(PERMISSIONS.receiptRecord),
  );
  const open = (id: string) =>
    void navigate({ to: '/finance/receipts/$receiptId', params: { receiptId: id } });

  return (
    <>
      <PageHeader
        title="Customer receipts"
        subtitle="Money received from customers and how it was allocated to invoices."
        actions={
          can(PERMISSIONS.receiptRecord) && (
            <Link to="/finance/receipts/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> Record receipt
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={onlyUnallocated}
              onChange={(e) => setOnlyUnallocated(e.target.checked)}
            />
            Only receipts with unallocated money
          </label>
        }
        actions={
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search number, customer, reference  ( / )"
            className="w-60 sm:w-80"
          />
        }
      >
        <ErrorBanner error={receipts.error} className="m-3" />
        {receipts.isPending ? (
          <Spinner />
        ) : receipts.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Receipt</th>
                <th className={th}>Date</th>
                <th className={th}>Customer</th>
                <th className={`${th} hidden md:table-cell`}>Mode</th>
                <th className={`${th} hidden lg:table-cell`}>Reference</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={`${th} text-right`}>Unallocated</th>
              </tr>
            </thead>
            <tbody>
              {receipts.data.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => open(r.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(r.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium whitespace-nowrap`}>
                    {r.receiptNumber}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(r.receiptDate)}</td>
                  <td className={`${td} max-w-64 truncate`}>{r.customerName}</td>
                  <td className={`${td} hidden md:table-cell`}>
                    {PAYMENT_MODE_LABELS[r.paymentMode]}
                  </td>
                  <td className={`${td} hidden font-mono text-xs lg:table-cell`}>
                    {r.reference ?? '—'}
                  </td>
                  <td className={`${tdNum} font-medium`}>{inr(r.amount)}</td>
                  <td className={tdNum}>
                    {r.unallocatedAmount === '0.00' ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <Badge tone="blue">{inr(r.unallocatedAmount)}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No receipts found" />
        )}
      </Panel>
    </>
  );
}

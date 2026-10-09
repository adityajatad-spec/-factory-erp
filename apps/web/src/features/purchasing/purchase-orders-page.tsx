import {
  PERMISSIONS,
  PURCHASE_ORDER_STATUSES,
  type PurchaseOrderListItemDto,
  type PurchaseOrderStatus,
} from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
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
import { PoStatusBadge } from './shared';

const route = getRouteApi('/app/purchasing/orders');
type View = '' | 'open' | 'overdue' | PurchaseOrderStatus;

export function PurchaseOrdersPage() {
  const can = useCan();
  const navigate = useNavigate();
  const search = route.useSearch();
  const [q, setQ] = useState(search.q ?? '');
  const [view, setView] = useState<View>(search.view ?? '');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);

  const orders = useQuery({
    queryKey: ['purchase-orders', debounced, view],
    queryFn: () =>
      api.get<PurchaseOrderListItemDto[]>('/purchase-orders', {
        q: debounced,
        limit: 200,
        ...(view === 'open' ? { open: 'true' } : {}),
        ...(view === 'overdue' ? { overdue: 'true' } : {}),
        ...(view && view !== 'open' && view !== 'overdue' ? { status: view } : {}),
      }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/purchasing/orders/new' }), [navigate]),
    can(PERMISSIONS.purchaseOrderDraft),
  );
  const open = (id: string) =>
    void navigate({ to: '/purchasing/orders/$orderId', params: { orderId: id } });

  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="Orders to suppliers: drafted, approved by someone allowed to, then received against."
        actions={
          can(PERMISSIONS.purchaseOrderDraft) && (
            <Link to="/purchasing/orders/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> New purchase order
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={`${orders.data?.length ?? 0} orders`}
        actions={
          <>
            <Select
              aria-label="Show"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              className="w-44"
            >
              <option value="">All orders</option>
              <option value="open">Open (expecting goods)</option>
              <option value="overdue">Overdue</option>
              {PURCHASE_ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ').toLowerCase()}
                </option>
              ))}
            </Select>
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search PO number or supplier  ( / )"
              className="w-56 sm:w-72"
            />
          </>
        }
      >
        <ErrorBanner error={orders.error} className="m-3" />
        {orders.isPending ? (
          <Spinner />
        ) : orders.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>PO</th>
                <th className={th}>Date</th>
                <th className={th}>Supplier</th>
                <th className={`${th} hidden md:table-cell`}>Deliver by</th>
                <th className={`${th} hidden lg:table-cell`}>Store</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr
                  key={o.id}
                  tabIndex={0}
                  onClick={() => open(o.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(o.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium whitespace-nowrap`}>
                    {o.poNumber ?? <span className="text-slate-400">Draft</span>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(o.poDate)}</td>
                  <td className={`${td} max-w-64 truncate`}>{o.supplierName}</td>
                  <td className={`${td} hidden whitespace-nowrap md:table-cell`}>
                    {date(o.expectedDate)}
                  </td>
                  <td className={`${td} hidden font-mono text-xs lg:table-cell`}>
                    {o.warehouseCode}
                  </td>
                  <td className={td}>
                    <PoStatusBadge status={o.status} overdue={o.isOverdue} />
                  </td>
                  <td className={`${tdNum} font-medium`}>{inr(o.grandTotal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No purchase orders found" />
        )}
      </Panel>
    </>
  );
}

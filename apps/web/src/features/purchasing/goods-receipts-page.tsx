import { PERMISSIONS, type GoodsReceiptListItemDto } from '@factory-erp/contracts';
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
  th,
} from '../../components/display';
import { Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';

export function GoodsReceiptsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const grns = useQuery({
    queryKey: ['goods-receipts', debounced],
    queryFn: () =>
      api.get<GoodsReceiptListItemDto[]>('/goods-receipts', { q: debounced, limit: 200 }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/purchasing/receipts/new' }), [navigate]),
    can(PERMISSIONS.goodsReceiptRecord),
  );
  const open = (id: string) =>
    void navigate({ to: '/purchasing/receipts/$grnId', params: { grnId: id } });

  return (
    <>
      <PageHeader
        title="Goods receipts"
        subtitle="What actually arrived against approved orders. Accepted goods go into stock."
        actions={
          can(PERMISSIONS.goodsReceiptRecord) && (
            <Link to="/purchasing/receipts/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> Receive goods
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={`${grns.data?.length ?? 0} receipts`}
        actions={
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search GRN, PO, supplier, challan  ( / )"
            className="w-60 sm:w-80"
          />
        }
      >
        <ErrorBanner error={grns.error} className="m-3" />
        {grns.isPending ? (
          <Spinner />
        ) : grns.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>GRN</th>
                <th className={th}>Date</th>
                <th className={th}>PO</th>
                <th className={th}>Supplier</th>
                <th className={`${th} hidden md:table-cell`}>Store</th>
                <th className={`${th} hidden lg:table-cell`}>Supplier challan</th>
              </tr>
            </thead>
            <tbody>
              {grns.data.map((g) => (
                <tr
                  key={g.id}
                  tabIndex={0}
                  onClick={() => open(g.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(g.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium`}>{g.grnNumber}</td>
                  <td className={`${td} whitespace-nowrap`}>{date(g.receiptDate)}</td>
                  <td className={`${td} font-mono text-xs`}>{g.poNumber}</td>
                  <td className={`${td} max-w-64 truncate`}>{g.supplierName}</td>
                  <td className={`${td} hidden font-mono text-xs md:table-cell`}>
                    {g.warehouseCode}
                  </td>
                  <td className={`${td} hidden font-mono text-xs lg:table-cell`}>
                    {g.supplierReference ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No goods received yet" />
        )}
      </Panel>
    </>
  );
}

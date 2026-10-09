import type { GoodsReceiptDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Button } from '../../components/button';
import {
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { api } from '../../lib/api';
import { date, dateTime, qty } from '../../lib/format';
import { HistoryPanel } from './shared';

export function GoodsReceiptDetailPage() {
  const { grnId } = useParams({ from: '/app/purchasing/receipts/$grnId' });
  const grn = useQuery({
    queryKey: ['goods-receipt', grnId],
    queryFn: () => api.get<GoodsReceiptDto>(`/goods-receipts/${grnId}`),
  });
  if (grn.isPending) return <Spinner />;
  if (grn.error) return <ErrorBanner error={grn.error} />;
  const g = grn.data;
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{g.grnNumber}</span>}
        subtitle={`${g.supplierName} · ${date(g.receiptDate)} · into ${g.warehouseCode}${g.supplierReference ? ` · challan ${g.supplierReference}` : ''}`}
        actions={
          <>
            <Link to="/purchasing/receipts">
              <Button>All receipts</Button>
            </Link>
            <Link to="/purchasing/orders/$orderId" params={{ orderId: g.orderId }}>
              <Button>Order {g.poNumber}</Button>
            </Link>
          </>
        }
      />
      <div className="space-y-4">
        <Panel title="Received">
          <Table>
            <thead>
              <tr>
                <th className={th}>Item</th>
                <th className={`${th} text-right`}>Received</th>
                <th className={`${th} text-right`}>Accepted (to stock)</th>
                <th className={`${th} text-right`}>Rejected</th>
                <th className={th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {g.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className={td}>
                    <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                    {l.itemName}
                  </td>
                  <td className={tdNum}>
                    {qty(l.receivedQuantity)} {l.uom}
                  </td>
                  <td className={`${tdNum} font-medium`}>{qty(l.acceptedQuantity)}</td>
                  <td className={tdNum}>
                    {l.rejectedQuantity === '0.000' ? '—' : qty(l.rejectedQuantity)}
                  </td>
                  <td className={`${td} text-slate-600`}>{l.rejectionReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            Recorded by {g.createdByName} · {dateTime(g.createdAt)}
            {g.notes ? ` · ${g.notes}` : ''}
          </p>
        </Panel>
        <HistoryPanel entityType="purchase.goods_receipt" entityId={g.id} />
      </div>
    </>
  );
}

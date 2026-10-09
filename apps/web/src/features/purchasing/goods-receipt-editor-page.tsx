import {
  PERMISSIONS,
  type GoodsReceiptDto,
  type PurchaseOrderDto,
  type PurchaseOrderListItemDto,
} from '@factory-erp/contracts';
import { isDecimalString } from '@factory-erp/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import { ErrorBanner, PageHeader, Panel, Spinner, td, tdNum, th } from '../../components/display';
import { Field, Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, qty, todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { matches } from '../invoices/use-invoice-masters';
import { PURCHASING_KEYS } from './shared';

const route = getRouteApi('/app/purchasing/receipts/new');

export function GoodsReceiptEditorPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const openOrders = useQuery({
    queryKey: ['purchase-orders', 'open-for-receipt'],
    queryFn: () =>
      api.get<PurchaseOrderListItemDto[]>('/purchase-orders', { open: 'true', limit: 200 }),
    enabled: !search.orderId,
  });
  const order = useQuery({
    queryKey: ['purchase-order', search.orderId],
    queryFn: () => api.get<PurchaseOrderDto>(`/purchase-orders/${search.orderId ?? ''}`),
    enabled: !!search.orderId,
  });

  if (!search.orderId) {
    const options = (openOrders.data ?? [])
      .filter((o) => matches(query, o.poNumber, o.supplierName))
      .slice(0, 50);
    return (
      <>
        <PageHeader
          title="Receive goods"
          subtitle="Choose the approved purchase order the delivery is against."
        />
        <ErrorBanner error={openOrders.error} className="mb-3" />
        <Panel title="Purchase order">
          <div className="max-w-xl p-3">
            <Combobox
              autoFocus
              options={options}
              value={null}
              query={query}
              onQueryChange={setQuery}
              onSelect={(o) =>
                void navigate({ to: '/purchasing/receipts/new', search: { orderId: o.id } })
              }
              getKey={(o) => o.id}
              getLabel={(o) => `${o.poNumber ?? ''} · ${o.supplierName}`}
              loading={openOrders.isPending}
              placeholder="Search open orders by PO number or supplier"
              renderOption={(o) => (
                <div className="flex justify-between gap-3">
                  <span className="truncate">
                    <span className="font-mono text-xs">{o.poNumber}</span> · {o.supplierName}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    due {date(o.expectedDate)}
                  </span>
                </div>
              )}
            />
          </div>
        </Panel>
      </>
    );
  }
  if (order.isPending) return <Spinner />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (order.data.status !== 'APPROVED' && order.data.status !== 'PARTIALLY_RECEIVED')
    return (
      <ErrorBanner
        error={new Error(`Purchase order ${order.data.poNumber ?? ''} is not open for receiving`)}
      />
    );
  return <ReceiptForm key={order.data.id} order={order.data} />;
}

interface Row {
  accepted: string;
  rejected: string;
  reason: string;
}

const isQty = (v: string) => v.trim() === '' || (isDecimalString(v.trim()) && !v.startsWith('-'));

function ReceiptForm({ order }: { order: PurchaseOrderDto }) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const open = order.lines.filter((l) => l.remainingQuantity !== '0.000');
  const [rows, setRows] = useState<Record<number, Row>>(() =>
    Object.fromEntries(
      open.map((l) => [l.lineNo, { accepted: qty(l.remainingQuantity), rejected: '', reason: '' }]),
    ),
  );
  const [receiptDate, setReceiptDate] = useState(todayIST());
  const [supplierReference, setSupplierReference] = useState('');
  const [notes, setNotes] = useState('');
  const set = (lineNo: number, patch: Partial<Row>) =>
    setRows((r) => ({
      ...r,
      [lineNo]: { ...(r[lineNo] ?? { accepted: '', rejected: '', reason: '' }), ...patch },
    }));

  const save = useMutation({
    mutationFn: () =>
      api.post<GoodsReceiptDto>('/goods-receipts', {
        orderId: order.id,
        receiptDate,
        supplierReference: supplierReference || null,
        notes: notes || null,
        lines: open
          .map((l) => ({ l, r: rows[l.lineNo] }))
          .filter(({ r }) => r && (r.accepted.trim() || r.rejected.trim()))
          .map(({ l, r }) => ({
            orderLineNo: l.lineNo,
            acceptedQuantity: r?.accepted.trim() || '0',
            rejectedQuantity: r?.rejected.trim() || '0',
            rejectionReason: r?.reason.trim() || null,
          })),
      }),
    onSuccess: async (grn) => {
      await Promise.all(
        PURCHASING_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
      await navigate({ to: '/purchasing/receipts/$grnId', params: { grnId: grn.id } });
    },
  });
  const invalid = Object.values(rows).some(
    (r) =>
      !isQty(r.accepted) ||
      !isQty(r.rejected) ||
      (r.rejected.trim() !== '' && r.rejected.trim() !== '0' && r.reason.trim().length < 3),
  );

  return (
    <>
      <PageHeader
        title={`Receive goods — ${order.poNumber ?? ''}`}
        subtitle={`${order.supplierName} · into ${order.warehouseName}. Only what is still to come can be received; rejected quantity needs a reason and does not enter stock.`}
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              disabled={save.isPending || invalid || !can(PERMISSIONS.goodsReceiptRecord)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Recording…' : 'Record receipt'}
            </Button>
          </>
        }
      />
      <ErrorBanner error={save.error} className="mb-3" />
      <div className="space-y-4">
        <Panel title="Delivery">
          <div className="grid gap-3 p-3 sm:grid-cols-3">
            <Field label="Receipt date" htmlFor="grn-date">
              <Input
                id="grn-date"
                type="date"
                value={receiptDate}
                min={order.poDate}
                max={todayIST()}
                onChange={(e) => setReceiptDate(e.target.value)}
              />
            </Field>
            <Field label="Supplier challan / delivery note" htmlFor="grn-ref">
              <Input
                id="grn-ref"
                value={supplierReference}
                maxLength={100}
                onChange={(e) => setSupplierReference(e.target.value)}
              />
            </Field>
            <Field label="Notes" htmlFor="grn-notes">
              <Input
                id="grn-notes"
                value={notes}
                maxLength={500}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </Panel>
        <Panel title="What arrived">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Ordered</th>
                  <th className={`${th} text-right`}>Still to come</th>
                  <th className={`${th} w-28 text-right`}>Accepted</th>
                  <th className={`${th} w-28 text-right`}>Rejected</th>
                  <th className={th}>Rejection reason</th>
                </tr>
              </thead>
              <tbody>
                {open.map((l) => {
                  const r = rows[l.lineNo] ?? { accepted: '', rejected: '', reason: '' };
                  return (
                    <tr key={l.lineNo}>
                      <td className={td}>
                        <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                        {l.description}
                      </td>
                      <td className={tdNum}>
                        {qty(l.quantity)} {l.uom}
                      </td>
                      <td className={tdNum}>{qty(l.remainingQuantity)}</td>
                      <td className={td}>
                        <Input
                          inputMode="decimal"
                          aria-label={`Accepted quantity, line ${l.lineNo}`}
                          className="text-right tabular"
                          value={r.accepted}
                          onChange={(e) => set(l.lineNo, { accepted: e.target.value })}
                        />
                      </td>
                      <td className={td}>
                        <Input
                          inputMode="decimal"
                          aria-label={`Rejected quantity, line ${l.lineNo}`}
                          className="text-right tabular"
                          placeholder="0"
                          value={r.rejected}
                          onChange={(e) => set(l.lineNo, { rejected: e.target.value })}
                        />
                      </td>
                      <td className={td}>
                        <Input
                          aria-label={`Rejection reason, line ${l.lineNo}`}
                          value={r.reason}
                          maxLength={300}
                          disabled={!r.rejected.trim() || r.rejected.trim() === '0'}
                          onChange={(e) => set(l.lineNo, { reason: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

import { PERMISSIONS, type PurchaseOrderDto } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import {
  Badge,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { Field, Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, dateTime, inr, qty } from '../../lib/format';
import { useCan } from '../../lib/session';
import { HistoryPanel, PoStatusBadge, PURCHASING_KEYS, Stat } from './shared';

type Confirm = 'approve' | 'delete' | 'cancel' | 'close' | null;

export function PurchaseOrderDetailPage() {
  const { orderId } = useParams({ from: '/app/purchasing/orders/$orderId' });
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reason, setReason] = useState('');

  const order = useQuery({
    queryKey: ['purchase-order', orderId],
    queryFn: () => api.get<PurchaseOrderDto>(`/purchase-orders/${orderId}`),
    // The PDF is rendered in the background after approval; poll briefly until it is attached.
    refetchInterval: (q) =>
      q.state.data && q.state.data.poNumber && !q.state.data.pdfDocumentId ? 1500 : false,
  });

  const refresh = async (updated?: PurchaseOrderDto) => {
    if (updated) queryClient.setQueryData(['purchase-order', orderId], updated);
    await Promise.all(PURCHASING_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  };
  const act = useMutation({
    mutationFn: async (kind: Exclude<Confirm, null>) => {
      const o = order.data;
      if (!o) throw new Error('Order not loaded');
      if (kind === 'delete') {
        await api.del(`/purchase-orders/${o.id}`, { expectedVersion: o.version });
        return null;
      }
      return api.post<PurchaseOrderDto>(`/purchase-orders/${o.id}/${kind}`, {
        expectedVersion: o.version,
        ...(kind === 'cancel' || kind === 'close' ? { reason } : {}),
      });
    },
    onSuccess: async (updated) => {
      setConfirm(null);
      setReason('');
      if (updated === null) {
        await refresh();
        await navigate({ to: '/purchasing/orders' });
        return;
      }
      await refresh(updated);
    },
  });

  if (order.isPending) return <Spinner />;
  if (order.error) return <ErrorBanner error={order.error} />;
  const o = order.data;
  const draft = o.status === 'DRAFT';
  const receiving = o.status === 'APPROVED' || o.status === 'PARTIALLY_RECEIVED';
  const billable = receiving || o.status === 'RECEIVED' || o.status === 'CLOSED';
  const pdfUrl = o.pdfDocumentId ? `/api/v1/documents/${o.pdfDocumentId}/content` : null;
  const intra = o.supplyType === 'INTRA_STATE';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{o.poNumber ?? 'Draft purchase order'}</span>
            <PoStatusBadge status={o.status} overdue={o.isOverdue} />
          </span>
        }
        subtitle={`${o.supplierName} · ${date(o.poDate)} · deliver to ${o.warehouseName}${o.expectedDate ? ` by ${date(o.expectedDate)}` : ''}`}
        actions={
          <>
            <Link to="/purchasing/orders">
              <Button>All orders</Button>
            </Link>
            {draft && can(PERMISSIONS.purchaseOrderDraft) && (
              <>
                <Link to="/purchasing/orders/$orderId/edit" params={{ orderId: o.id }}>
                  <Button>Edit</Button>
                </Link>
                <Button variant="danger" onClick={() => setConfirm('delete')}>
                  Delete
                </Button>
              </>
            )}
            {draft && can(PERMISSIONS.purchaseOrderApprove) && (
              <Button variant="primary" onClick={() => setConfirm('approve')}>
                Approve
              </Button>
            )}
            {receiving && can(PERMISSIONS.goodsReceiptRecord) && (
              <Link to="/purchasing/receipts/new" search={{ orderId: o.id }}>
                <Button variant="primary">Receive goods</Button>
              </Link>
            )}
            {billable && can(PERMISSIONS.purchaseInvoiceDraft) && (
              <Link to="/purchasing/bills/new" search={{ orderId: o.id }}>
                <Button>Enter supplier bill</Button>
              </Link>
            )}
            {(draft || (o.status === 'APPROVED' && o.receipts.length === 0)) &&
              can(PERMISSIONS.purchaseOrderCancel) && (
                <Button variant="danger" onClick={() => setConfirm('cancel')}>
                  Cancel order
                </Button>
              )}
            {receiving && o.receipts.length > 0 && can(PERMISSIONS.purchaseOrderCancel) && (
              <Button onClick={() => setConfirm('close')}>Short-close</Button>
            )}
          </>
        }
      />
      <ErrorBanner error={act.error} className="mb-3" />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Order total" value={inr(o.grandTotal)} />
        <Stat label="Taxable value" value={inr(o.taxableAmount)} />
        <Stat
          label={intra ? 'CGST + SGST' : 'IGST'}
          value={inr(
            intra ? Money.of(o.cgstAmount).plus(Money.of(o.sgstAmount)).toString() : o.igstAmount,
          )}
        />
        <Stat
          label="Approved"
          value={o.approvedAt ? `${o.approvedByName ?? ''} · ${dateTime(o.approvedAt)}` : '—'}
        />
      </div>

      <div className="space-y-4">
        <Panel
          title="Lines — ordered, received and billed"
          actions={
            pdfUrl ? (
              <>
                <a href={pdfUrl} target="_blank" rel="noreferrer">
                  <Button size="sm">View PDF</Button>
                </a>
                <a href={`${pdfUrl}?download=1`}>
                  <Button size="sm">Download</Button>
                </a>
              </>
            ) : o.poNumber ? (
              <span className="text-xs text-slate-500">PDF is being prepared…</span>
            ) : null
          }
        >
          <Table>
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Item</th>
                <th className={`${th} text-right`}>Ordered</th>
                <th className={`${th} text-right`}>Accepted</th>
                <th className={`${th} hidden text-right md:table-cell`}>Rejected</th>
                <th className={`${th} text-right`}>To come</th>
                <th className={`${th} hidden text-right md:table-cell`}>Billed</th>
                <th className={`${th} hidden text-right lg:table-cell`}>Rate</th>
                <th className={`${th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className={`${td} text-xs text-slate-500`}>{l.lineNo}</td>
                  <td className={td}>
                    <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                    {l.description}
                    <span className="block text-[11px] text-slate-500">
                      HSN {l.hsnCode} · GST {qty(l.gstRatePercent)}%
                    </span>
                  </td>
                  <td className={tdNum}>
                    {qty(l.quantity)} {l.uom}
                  </td>
                  <td className={tdNum}>{qty(l.acceptedQuantity)}</td>
                  <td className={`${tdNum} hidden md:table-cell`}>
                    {l.rejectedQuantity === '0.000' ? '—' : qty(l.rejectedQuantity)}
                  </td>
                  <td className={tdNum}>
                    {l.remainingQuantity === '0.000' ? (
                      <Badge tone="green">Done</Badge>
                    ) : (
                      qty(l.remainingQuantity)
                    )}
                  </td>
                  <td className={`${tdNum} hidden md:table-cell`}>{qty(l.invoicedQuantity)}</td>
                  <td className={`${tdNum} hidden lg:table-cell`}>{inr(l.unitRate)}</td>
                  <td className={`${tdNum} font-medium`}>{inr(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            {o.amountInWords}
            {o.notes ? ` · Notes: ${o.notes}` : ''}
          </p>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Goods receipts">
            {o.receipts.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">Nothing received yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {o.receipts.map((g) => (
                  <li key={g.id} className="flex justify-between px-3 py-2 text-sm">
                    <Link
                      to="/purchasing/receipts/$grnId"
                      params={{ grnId: g.id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {g.grnNumber}
                    </Link>
                    <span className="text-slate-500">{date(g.receiptDate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Supplier bills">
            {o.invoices.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">No bills entered against this order.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {o.invoices.map((b) => (
                  <li key={b.id} className="flex justify-between px-3 py-2 text-sm">
                    <Link
                      to="/purchasing/bills/$invoiceId"
                      params={{ invoiceId: b.id }}
                      className="hover:underline"
                    >
                      <span className="font-mono text-xs">{b.invoiceNumber ?? 'Draft'}</span> ·{' '}
                      {b.supplierInvoiceNumber}
                    </Link>
                    <Badge tone={b.status === 'POSTED' ? 'green' : 'neutral'}>{b.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {o.closeReason && <p className="text-sm text-slate-600">Short-closed: {o.closeReason}</p>}
        {o.cancelReason && <p className="text-sm text-slate-600">Cancelled: {o.cancelReason}</p>}

        <HistoryPanel entityType="purchase.order" entityId={o.id} refreshKey={o.version} />
      </div>

      <Dialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        title="Approve this purchase order?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button
              variant="primary"
              disabled={act.isPending}
              onClick={() => act.mutate('approve')}
            >
              {act.isPending ? 'Approving…' : `Approve ${inr(o.grandTotal)}`}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          The order is repriced from current rates, numbered and frozen. Goods can then be received
          against it, and its PDF is prepared in the background.
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'cancel' || confirm === 'close'}
        onClose={() => setConfirm(null)}
        title={confirm === 'close' ? 'Short-close this order?' : 'Cancel this order?'}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button
              variant="danger"
              disabled={act.isPending || reason.trim().length < 3}
              onClick={() => confirm && act.mutate(confirm)}
            >
              {confirm === 'close' ? 'Short-close' : 'Cancel order'}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-700">
          {confirm === 'close'
            ? 'What is still to come will not be delivered. Received goods and bills stay as they are.'
            : 'Nothing has been received, so the order simply ends. It is kept for the record.'}
        </p>
        <Field label="Reason" htmlFor="end-reason">
          <Input
            id="end-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </Field>
      </Dialog>
      <Dialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this draft?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate('delete')}>
              Delete draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">The draft has no number yet and is removed.</p>
      </Dialog>
    </>
  );
}

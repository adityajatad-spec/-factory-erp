import {
  PERMISSIONS,
  type PurchaseInvoiceDto,
  type PurchaseInvoiceMatchDto,
} from '@factory-erp/contracts';
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
import {
  FINDING_LABELS,
  HistoryPanel,
  MatchBadge,
  PayableBadge,
  PURCHASING_KEYS,
  Stat,
} from './shared';

export function BillDetailPage() {
  const { invoiceId } = useParams({ from: '/app/purchasing/bills/$invoiceId' });
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'post' | 'delete' | null>(null);
  const [reason, setReason] = useState('');

  const bill = useQuery({
    queryKey: ['bill', invoiceId],
    queryFn: () => api.get<PurchaseInvoiceDto>(`/purchase-invoices/${invoiceId}`),
  });
  const match = useQuery({
    queryKey: ['bill', invoiceId, 'match', bill.data?.version],
    queryFn: () => api.get<PurchaseInvoiceMatchDto>(`/purchase-invoices/${invoiceId}/match`),
    enabled: !!bill.data,
  });

  const act = useMutation({
    mutationFn: async (kind: 'post' | 'delete') => {
      const b = bill.data;
      if (!b) throw new Error('Bill not loaded');
      if (kind === 'delete') {
        await api.del(`/purchase-invoices/${b.id}`, { expectedVersion: b.version });
        return null;
      }
      return api.post<PurchaseInvoiceDto>(`/purchase-invoices/${b.id}/post`, {
        expectedVersion: b.version,
        matchOverrideReason: reason.trim() || null,
      });
    },
    onSuccess: async (updated) => {
      setConfirm(null);
      setReason('');
      await Promise.all(
        PURCHASING_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
      if (updated === null) await navigate({ to: '/purchasing/bills' });
      else queryClient.setQueryData(['bill', invoiceId], updated);
    },
  });

  if (bill.isPending) return <Spinner />;
  if (bill.error) return <ErrorBanner error={bill.error} />;
  const b = bill.data;
  const draft = b.status === 'DRAFT';
  const findings = match.data?.findings ?? [];
  const differences = findings.length > 0;
  const canOverride = can(PERMISSIONS.purchaseInvoiceOverrideMatch);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{b.invoiceNumber ?? 'Draft bill'}</span>
            <PayableBadge status={b.payableStatus} overdue={b.isOverdue} />
            <MatchBadge status={b.matchStatus} />
          </span>
        }
        subtitle={`${b.supplierName} · bill ${b.supplierInvoiceNumber} dated ${date(b.invoiceDate)} · due ${date(b.dueDate)}${b.poNumber ? ` · PO ${b.poNumber}` : ' · direct (no PO)'}`}
        actions={
          <>
            <Link to="/purchasing/bills">
              <Button>All bills</Button>
            </Link>
            {b.orderId && (
              <Link to="/purchasing/orders/$orderId" params={{ orderId: b.orderId }}>
                <Button>Order {b.poNumber}</Button>
              </Link>
            )}
            {draft && can(PERMISSIONS.purchaseInvoiceDraft) && (
              <>
                <Link to="/purchasing/bills/$invoiceId/edit" params={{ invoiceId: b.id }}>
                  <Button>Edit</Button>
                </Link>
                <Button variant="danger" onClick={() => setConfirm('delete')}>
                  Delete
                </Button>
              </>
            )}
            {draft && can(PERMISSIONS.purchaseInvoicePost) && (
              <Button
                variant="primary"
                disabled={match.isPending || (differences && !canOverride)}
                title={
                  differences && !canOverride
                    ? 'This bill does not match; someone allowed to accept differences must post it'
                    : undefined
                }
                onClick={() => setConfirm('post')}
              >
                Post bill
              </Button>
            )}
            {b.payableStatus &&
              b.payableStatus !== 'PAID' &&
              can(PERMISSIONS.supplierPaymentRequest) && (
                <Link
                  to="/finance/supplier-payments/new"
                  search={{ supplierId: b.supplierId, invoiceId: b.id }}
                >
                  <Button variant="primary">Record payment</Button>
                </Link>
              )}
          </>
        }
      />
      <ErrorBanner error={act.error} className="mb-3" />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bill total (computed)" value={inr(b.grandTotal)} />
        <Stat label="Total on the bill" value={inr(b.supplierStatedTotal)} />
        <Stat label="Paid" value={inr(b.paidAmount)} />
        <Stat
          label="Outstanding"
          testId="bill-outstanding"
          value={draft ? '—' : inr(b.outstandingAmount)}
          tone={b.isOverdue ? 'bad' : b.outstandingAmount !== '0.00' && !draft ? 'warn' : 'plain'}
        />
      </div>

      <div className="space-y-4">
        <Panel
          title={
            <span className="flex items-center gap-2">
              Three-way match
              {match.data && (
                <span className="text-xs font-normal text-slate-500">
                  tolerances: qty {qty(match.data.tolerances.qtyPercent)}% · price{' '}
                  {qty(match.data.tolerances.pricePercent)}% · total{' '}
                  {inr(match.data.tolerances.totalAmount)}
                </span>
              )}
            </span>
          }
        >
          <ErrorBanner error={match.error} className="m-3" />
          {match.isPending ? (
            <Spinner />
          ) : findings.length === 0 ? (
            <p className="p-3 text-sm text-emerald-800">
              {b.orderId
                ? 'The bill agrees with the purchase order and with what was received.'
                : 'Direct bill: the total agrees with the computed total.'}
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Difference</th>
                  <th className={th}>Line</th>
                  <th className={`${th} text-right`}>Expected</th>
                  <th className={`${th} text-right`}>On the bill</th>
                  <th className={`${th} hidden md:table-cell`}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, i) => (
                  <tr key={`${f.code}-${i}`}>
                    <td className={td}>
                      <Badge tone="amber">{FINDING_LABELS[f.code]}</Badge>
                    </td>
                    <td className={`${td} text-xs`}>{f.invoiceLineNo ?? '—'}</td>
                    <td className={`${tdNum}`}>{f.expected ?? '—'}</td>
                    <td className={`${tdNum} font-medium`}>{f.actual ?? '—'}</td>
                    <td className={`${td} hidden text-xs text-slate-600 md:table-cell`}>
                      {f.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {b.matchOverrideReason && (
            <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
              Accepted with differences: {b.matchOverrideReason}
            </p>
          )}
        </Panel>

        <Panel title="Lines">
          <Table>
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Item</th>
                <th className={`${th} hidden md:table-cell`}>PO line</th>
                <th className={`${th} text-right`}>Qty</th>
                <th className={`${th} text-right`}>Rate</th>
                <th className={`${th} hidden text-right md:table-cell`}>Taxable</th>
                <th className={`${th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className={`${td} text-xs text-slate-500`}>{l.lineNo}</td>
                  <td className={td}>
                    <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                    {l.description}
                  </td>
                  <td className={`${td} hidden md:table-cell`}>{l.orderLineNo ?? '—'}</td>
                  <td className={tdNum}>
                    {qty(l.quantity)} {l.uom}
                  </td>
                  <td className={tdNum}>{inr(l.unitRate)}</td>
                  <td className={`${tdNum} hidden md:table-cell`}>{inr(l.taxableAmount)}</td>
                  <td className={`${tdNum} font-medium`}>{inr(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            {b.supplyType === 'INTRA_STATE'
              ? `CGST ${inr(b.cgstAmount)} · SGST ${inr(b.sgstAmount)}`
              : `IGST ${inr(b.igstAmount)}`}{' '}
            · round off {inr(b.roundOff)} · {b.amountInWords}
            {b.postedAt ? ` · posted by ${b.postedByName ?? ''} ${dateTime(b.postedAt)}` : ''}
          </p>
        </Panel>

        <Panel title="Payments">
          {b.payments.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">Nothing paid against this bill yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {b.payments.map((p) => (
                <li key={p.paymentId} className="flex justify-between px-3 py-2 text-sm">
                  <Link
                    to="/finance/supplier-payments/$paymentId"
                    params={{ paymentId: p.paymentId }}
                    className="font-mono text-xs hover:underline"
                  >
                    {p.paymentNumber ?? 'Pending'}
                  </Link>
                  <span className="text-slate-500">{date(p.paymentDate)}</span>
                  <span className="font-medium tabular">{inr(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <HistoryPanel entityType="purchase.invoice" entityId={b.id} refreshKey={b.version} />
      </div>

      <Dialog
        open={confirm === 'post'}
        onClose={() => setConfirm(null)}
        title={differences ? 'Post a bill that does not match?' : 'Post this bill?'}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button
              variant="primary"
              disabled={act.isPending || (differences && reason.trim().length < 3)}
              onClick={() => act.mutate('post')}
            >
              {act.isPending ? 'Posting…' : `Post ${inr(b.grandTotal)}`}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          Posting numbers the bill, freezes it and adds {inr(b.grandTotal)} to what we owe{' '}
          {b.supplierName}. It is checked against the order and receipts again, under lock.
        </p>
        {differences && (
          <div className="mt-3">
            <p className="mb-2 text-sm text-amber-800">
              {findings.length} difference{findings.length > 1 ? 's' : ''} found. Say why they are
              acceptable — this is recorded with the bill.
            </p>
            <Field label="Reason for accepting the differences" htmlFor="override-reason">
              <Input
                id="override-reason"
                autoFocus
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this draft bill?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate('delete')}>
              Delete draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">The draft is removed; nothing was owed yet.</p>
      </Dialog>
    </>
  );
}

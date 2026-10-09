import { PERMISSIONS, type SupplierPaymentDto } from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
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
import { Field, Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, dateTime, inr } from '../../lib/format';
import { useCan, useSession } from '../../lib/session';
import { HistoryPanel, PaymentStatusBadge, PURCHASING_KEYS, Stat } from '../purchasing/shared';
import { checkDraftAllocations } from '../receivables/allocation-math';
import { PAYMENT_MODE_LABELS } from '../receivables/labels';
import {
  asOpenAmounts,
  BillAllocationEditor,
  billAllocationsPayload,
  openBillsQuery,
} from './bill-allocation-editor';

export function SupplierPaymentDetailPage() {
  const { paymentId } = useParams({ from: '/app/finance/supplier-payments/$paymentId' });
  const can = useCan();
  const session = useSession();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const payment = useQuery({
    queryKey: ['supplier-payment', paymentId],
    queryFn: () => api.get<SupplierPaymentDto>(`/supplier-payments/${paymentId}`),
  });
  const supplierId = payment.data?.supplierId ?? '';
  const open = useQuery({ ...openBillsQuery(supplierId), enabled: !!supplierId });

  const done = async (updated: SupplierPaymentDto) => {
    queryClient.setQueryData(['supplier-payment', paymentId], updated);
    setConfirm(null);
    setReason('');
    setAmounts({});
    await Promise.all(PURCHASING_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  };
  const decide = useMutation({
    mutationFn: (kind: 'approve' | 'reject') =>
      api.post<SupplierPaymentDto>(`/supplier-payments/${paymentId}/${kind}`, {
        expectedVersion: payment.data?.version,
        ...(kind === 'reject' ? { reason } : {}),
      }),
    onSuccess: done,
  });
  const allocate = useMutation({
    mutationFn: () =>
      api.post<SupplierPaymentDto>(`/supplier-payments/${paymentId}/allocations`, {
        allocations: billAllocationsPayload(amounts),
      }),
    onSuccess: done,
  });

  if (payment.isPending) return <Spinner />;
  if (payment.error) return <ErrorBanner error={payment.error} />;
  const p = payment.data;
  const pending = p.status === 'PENDING_APPROVAL';
  const mine = p.requestedById === session.id;
  const onAccount = p.status === 'APPROVED' && p.unallocatedAmount !== '0.00';
  const check = checkDraftAllocations(p.unallocatedAmount, asOpenAmounts(open.data ?? []), amounts);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{p.paymentNumber ?? 'Supplier payment'}</span>
            <PaymentStatusBadge status={p.status} />
          </span>
        }
        subtitle={`${p.supplierName} · ${date(p.paymentDate)} · ${PAYMENT_MODE_LABELS[p.paymentMode]}${p.reference ? ` · ${p.reference}` : ''}`}
        actions={
          <>
            <Link to="/finance/supplier-payments">
              <Button>All payments</Button>
            </Link>
            {pending && can(PERMISSIONS.supplierPaymentApprove) && (
              <>
                <Button variant="danger" onClick={() => setConfirm('reject')}>
                  Reject
                </Button>
                <Button
                  variant="primary"
                  disabled={mine}
                  title={
                    mine
                      ? 'You recorded this payment; a different person must approve it'
                      : undefined
                  }
                  onClick={() => setConfirm('approve')}
                >
                  Approve
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorBanner error={decide.error ?? allocate.error} className="mb-3" />
      {pending && mine && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You recorded this payment. Someone else with approval rights must approve it
          (maker-checker).
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Amount" value={inr(p.amount)} />
        <Stat label="Settles bills" value={inr(p.allocatedAmount)} />
        <Stat
          label="On account"
          value={inr(p.unallocatedAmount)}
          tone={onAccount ? 'info' : 'plain'}
        />
        <Stat
          label={p.status === 'REJECTED' ? 'Rejected by' : 'Recorded → approved'}
          value={
            p.status === 'REJECTED'
              ? (p.rejectedByName ?? '—')
              : `${p.requestedByName} → ${p.approvedByName ?? '…'}`
          }
        />
      </div>

      <div className="space-y-4">
        {pending && (
          <Panel title="Bills it will settle when approved">
            {p.proposedAllocations.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">
                None: the whole amount will be held on account as an advance.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Bill</th>
                    <th className={th}>Supplier no.</th>
                    <th className={`${th} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {p.proposedAllocations.map((a) => (
                    <tr key={a.purchaseInvoiceId}>
                      <td className={`${td} font-mono text-xs`}>
                        <Link
                          to="/purchasing/bills/$invoiceId"
                          params={{ invoiceId: a.purchaseInvoiceId }}
                          className="hover:underline"
                        >
                          {a.invoiceNumber ?? '—'}
                        </Link>
                      </td>
                      <td className={`${td} font-mono text-xs`}>{a.supplierInvoiceNumber}</td>
                      <td className={`${tdNum} font-medium`}>{inr(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        )}

        {p.status === 'APPROVED' && (
          <Panel title="Bills settled">
            {p.allocations.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">Not allocated to any bill yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Bill</th>
                    <th className={th}>Supplier no.</th>
                    <th className={`${th} text-right`}>Amount</th>
                    <th className={`${th} hidden md:table-cell`}>Allocated</th>
                  </tr>
                </thead>
                <tbody>
                  {p.allocations.map((a) => (
                    <tr key={a.id}>
                      <td className={`${td} font-mono text-xs`}>
                        <Link
                          to="/purchasing/bills/$invoiceId"
                          params={{ invoiceId: a.purchaseInvoiceId }}
                          className="hover:underline"
                        >
                          {a.invoiceNumber}
                        </Link>
                      </td>
                      <td className={`${td} font-mono text-xs`}>{a.supplierInvoiceNumber}</td>
                      <td className={`${tdNum} font-medium`}>{inr(a.amount)}</td>
                      <td className={`${td} hidden text-xs text-slate-500 md:table-cell`}>
                        {a.allocatedByName ?? '—'} · {dateTime(a.allocatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        )}

        {onAccount && can(PERMISSIONS.supplierPaymentRequest) && (
          <Panel
            title="Allocate money held on account"
            actions={
              <Button
                variant="primary"
                size="sm"
                disabled={
                  !billAllocationsPayload(amounts).length || !check.valid || allocate.isPending
                }
                onClick={() => allocate.mutate()}
              >
                {allocate.isPending ? 'Allocating…' : 'Save allocation'}
              </Button>
            }
          >
            <BillAllocationEditor
              supplierId={p.supplierId}
              available={p.unallocatedAmount}
              amounts={amounts}
              onChange={setAmounts}
            />
          </Panel>
        )}

        {p.rejectionReason && (
          <p className="text-sm text-slate-600">Rejected: {p.rejectionReason}</p>
        )}
        {p.notes && <p className="text-sm text-slate-600">Notes: {p.notes}</p>}

        <HistoryPanel
          entityType="finance.supplier_payment"
          entityId={p.id}
          refreshKey={p.version}
        />
      </div>

      <Dialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        title="Approve this supplier payment?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button
              variant="primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              {decide.isPending ? 'Approving…' : `Approve ${inr(p.amount)}`}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          It is numbered, reduces what we owe {p.supplierName} and settles the bills listed —
          checked again now; if a bill was paid meanwhile, approval is refused and nothing changes.
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'reject'}
        onClose={() => setConfirm(null)}
        title="Reject this payment?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Back</Button>
            <Button
              variant="danger"
              disabled={decide.isPending || reason.trim().length < 3}
              onClick={() => decide.mutate('reject')}
            >
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reject-reason">
          <Input
            id="reject-reason"
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Dialog>
    </>
  );
}

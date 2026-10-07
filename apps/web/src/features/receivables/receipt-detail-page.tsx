import { PERMISSIONS, type AuditEventDto, type ReceiptDto } from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
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
import { date, dateTime, inr } from '../../lib/format';
import { useCan } from '../../lib/session';
import { checkDraftAllocations } from './allocation-math';
import { AllocationEditor, allocationsPayload, openInvoicesQuery } from './allocation-editor';
import { PAYMENT_MODE_LABELS } from './labels';

export function ReceiptDetailPage() {
  const { receiptId } = useParams({ from: '/app/finance/receipts/$receiptId' });
  const can = useCan();
  const queryClient = useQueryClient();
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const receipt = useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => api.get<ReceiptDto>(`/receipts/${receiptId}`),
  });
  const history = useQuery({
    queryKey: ['audit', 'finance.receipt', receiptId, receipt.data?.allocatedAmount],
    queryFn: () =>
      api.get<AuditEventDto[]>('/audit-events', {
        entityType: 'finance.receipt',
        entityId: receiptId,
      }),
    enabled: can(PERMISSIONS.auditRead),
  });
  const customerId = receipt.data?.customerId ?? '';
  const open = useQuery({ ...openInvoicesQuery(customerId), enabled: !!customerId });

  const allocate = useMutation({
    mutationFn: () =>
      api.post<ReceiptDto>(`/receipts/${receiptId}/allocations`, {
        allocations: allocationsPayload(amounts),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['receipt', receiptId], updated);
      setAmounts({});
      await Promise.all(
        ['receipts', 'receivables', 'invoices', 'invoice', 'dashboard', 'audit'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
    },
  });

  if (receipt.isPending) return <Spinner />;
  if (receipt.error) return <ErrorBanner error={receipt.error} />;
  const r = receipt.data;
  const hasCredit = r.unallocatedAmount !== '0.00';
  const check = checkDraftAllocations(r.unallocatedAmount, open.data ?? [], amounts);
  const pending = allocationsPayload(amounts).length > 0;

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{r.receiptNumber}</span>}
        subtitle={`${r.customerName} · ${date(r.receiptDate)} · ${PAYMENT_MODE_LABELS[r.paymentMode]}${r.reference ? ` · ${r.reference}` : ''}`}
        actions={
          <Link to="/finance/receipts">
            <Button>All receipts</Button>
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Amount received" value={inr(r.amount)} />
        <Stat label="Allocated to invoices" value={inr(r.allocatedAmount)} />
        <Stat
          label="Unallocated (on account)"
          value={inr(r.unallocatedAmount)}
          highlight={hasCredit}
        />
      </div>

      <div className="space-y-4">
        <Panel title="Allocations">
          {r.allocations.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">Not allocated to any invoice yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Invoice</th>
                  <th className={th}>Invoice date</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={`${th} hidden md:table-cell`}>Allocated</th>
                </tr>
              </thead>
              <tbody>
                {r.allocations.map((a) => (
                  <tr key={a.id}>
                    <td className={`${td} font-mono text-xs`}>
                      <Link
                        to="/sales/invoices/$invoiceId"
                        params={{ invoiceId: a.invoiceId }}
                        className="hover:underline"
                      >
                        {a.invoiceNumber}
                      </Link>
                    </td>
                    <td className={td}>{date(a.invoiceDate)}</td>
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

        {hasCredit && can(PERMISSIONS.receiptRecord) && (
          <Panel
            title="Allocate the unallocated amount"
            actions={
              <Button
                variant="primary"
                size="sm"
                disabled={!pending || !check.valid || allocate.isPending}
                onClick={() => allocate.mutate()}
              >
                {allocate.isPending ? 'Allocating…' : 'Save allocation'}
              </Button>
            }
          >
            <ErrorBanner error={allocate.error} className="m-3" />
            <AllocationEditor
              customerId={r.customerId}
              available={r.unallocatedAmount}
              amounts={amounts}
              onChange={setAmounts}
            />
          </Panel>
        )}

        {r.notes && <p className="text-sm text-slate-600">Notes: {r.notes}</p>}

        {can(PERMISSIONS.auditRead) && (
          <Panel title="History (audit trail)">
            <ol className="divide-y divide-slate-100">
              {(history.data ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm">
                  <span>{e.summary}</span>
                  <span className="text-xs text-slate-500">
                    {e.actorName ?? e.actorKind} · {dateTime(e.occurredAt)}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        )}
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-3 ${highlight ? 'border-sky-200 bg-sky-50' : 'border-slate-200 bg-white'}`}
    >
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900 tabular">{value}</p>
    </div>
  );
}

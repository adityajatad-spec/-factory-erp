import {
  PERMISSIONS,
  type AuditEventDto,
  type CompanyDto,
  type InvoiceDto,
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
import { CreditNoteStatusBadge, REASON_LABELS } from '../credit-notes/labels';
import { PAYMENT_MODE_LABELS, PaymentBadge } from '../receivables/labels';
import { StatusBadge } from './invoice-table';

export function InvoiceDetailPage() {
  const { invoiceId } = useParams({ from: '/app/sales/invoices/$invoiceId' });
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'issue' | 'delete' | 'cancel' | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const invoice = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDto>(`/sales-invoices/${invoiceId}`),
    // The PDF is produced asynchronously by the outbox worker after issue.
    refetchInterval: (q) =>
      q.state.data && q.state.data.status !== 'DRAFT' && !q.state.data.pdfDocumentId ? 1500 : false,
  });
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyDto>('/company'),
    staleTime: 10 * 60_000,
  });
  const history = useQuery({
    queryKey: [
      'audit',
      'sales.invoice',
      invoiceId,
      invoice.data?.version,
      invoice.data?.pdfDocumentId,
    ],
    queryFn: () =>
      api.get<AuditEventDto[]>('/audit-events', {
        entityType: 'sales.invoice',
        entityId: invoiceId,
      }),
    enabled: can(PERMISSIONS.auditRead),
  });

  const refresh = async (updated?: InvoiceDto) => {
    if (updated) queryClient.setQueryData(['invoice', invoiceId], updated);
    await Promise.all(
      ['invoices', 'dashboard', 'audit', 'receivables'].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
  };

  const issue = useMutation({
    mutationFn: (version: number) =>
      api.post<InvoiceDto>(`/sales-invoices/${invoiceId}/issue`, { expectedVersion: version }),
    onSuccess: async (updated) => {
      setConfirm(null);
      await refresh(updated);
    },
  });
  const cancel = useMutation({
    mutationFn: (version: number) =>
      api.post<InvoiceDto>(`/sales-invoices/${invoiceId}/cancel`, {
        expectedVersion: version,
        reason: cancelReason.trim(),
      }),
    onSuccess: async (updated) => {
      setConfirm(null);
      await refresh(updated);
    },
  });
  const remove = useMutation({
    mutationFn: (version: number) =>
      api.del<unknown>(`/sales-invoices/${invoiceId}`, { expectedVersion: version }),
    onSuccess: async () => {
      setConfirm(null);
      queryClient.removeQueries({ queryKey: ['invoice', invoiceId] });
      await refresh();
      await navigate({ to: '/sales/invoices' });
    },
  });

  if (invoice.isPending) return <Spinner />;
  if (invoice.error || !invoice.data)
    return <ErrorBanner error={invoice.error ?? new Error('Invoice not found')} />;
  const inv = invoice.data;
  const intra = inv.supplyType === 'INTRA_STATE';
  const specimen = company.data && company.data.financeReadiness !== 'PRODUCTION';
  const pdfUrl = inv.pdfDocumentId ? `/api/v1/documents/${inv.pdfDocumentId}/content` : null;
  const isZero = (v: string | null) => v === null || /^-?0+(\.0+)?$/.test(v);
  const owes = inv.status === 'ISSUED' && !isZero(inv.outstandingAmount);
  const canRecordPayment = owes && can(PERMISSIONS.receiptRecord);
  const canCredit = owes && can(PERMISSIONS.creditNoteDraft);
  // Only an invoice nothing has settled can be cancelled (no refunds or un-allocation yet).
  const canCancel =
    inv.status === 'ISSUED' &&
    isZero(inv.paidAmount) &&
    isZero(inv.creditedAmount) &&
    can(PERMISSIONS.salesInvoiceCancel);
  const reasonValid = cancelReason.trim().length >= 3;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {inv.invoiceNumber ?? 'Draft invoice'} <StatusBadge status={inv.status} />{' '}
            <PaymentBadge status={inv.paymentStatus} />
          </span>
        }
        subtitle={`${inv.customerName} · ${date(inv.invoiceDate)} · ${inv.placeOfSupplyStateName} (${inv.placeOfSupplyStateCode}) · ${intra ? 'CGST + SGST' : 'IGST'}`}
        actions={
          inv.status === 'DRAFT' ? (
            <>
              {can(PERMISSIONS.salesInvoiceDraft) && (
                <>
                  <Button variant="danger" onClick={() => setConfirm('delete')}>
                    Delete draft
                  </Button>
                  <Link to="/sales/invoices/$invoiceId/edit" params={{ invoiceId }}>
                    <Button>Edit</Button>
                  </Link>
                </>
              )}
              {can(PERMISSIONS.salesInvoiceIssue) && (
                <Button variant="primary" onClick={() => setConfirm('issue')}>
                  Issue invoice…
                </Button>
              )}
            </>
          ) : (
            <>
              {canRecordPayment && (
                <Link
                  to="/finance/receipts/new"
                  search={{ customerId: inv.customerId, invoiceId: inv.id }}
                >
                  <Button variant="primary">Record payment</Button>
                </Link>
              )}
              {canCredit && (
                <Link to="/sales/credit-notes/new" search={{ invoiceId: inv.id }}>
                  <Button>Credit note</Button>
                </Link>
              )}
              {canCancel && (
                <Button variant="danger" onClick={() => setConfirm('cancel')}>
                  Cancel invoice…
                </Button>
              )}
              {pdfUrl ? (
                <>
                  <a href={pdfUrl} target="_blank" rel="noreferrer">
                    <Button variant={canRecordPayment ? 'secondary' : 'primary'}>
                      {inv.status === 'CANCELLED' ? 'Open PDF (as issued)' : 'Open PDF'}
                    </Button>
                  </a>
                  <a href={`${pdfUrl}?download=1`}>
                    <Button>Download</Button>
                  </a>
                </>
              ) : (
                <span className="text-sm text-slate-500">Generating PDF…</span>
              )}
            </>
          )
        }
      />

      {inv.cancellation && (
        <div
          role="status"
          className="mb-3 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-800"
        >
          <strong>Cancelled</strong> on {dateTime(inv.cancellation.cancelledAt)}
          {inv.cancellation.cancelledByName && ` by ${inv.cancellation.cancelledByName}`}:{' '}
          {inv.cancellation.reason}. The invoice keeps its number and values for the record; its
          amount was reversed from the customer&apos;s balance and nothing is outstanding.
        </div>
      )}
      {inv.status !== 'DRAFT' && specimen && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Specimen mode: GST calculations have not yet been validated by a chartered accountant, so
          issued PDFs are watermarked “SPECIMEN — not a valid tax invoice”.
        </div>
      )}
      <ErrorBanner error={issue.error ?? remove.error} className="mb-3" />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Panel title="Lines">
            <Table>
              <thead>
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>Description</th>
                  <th className={th}>HSN</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Disc</th>
                  <th className={`${th} text-right`}>Taxable</th>
                  {intra ? (
                    <>
                      <th className={`${th} text-right`}>CGST</th>
                      <th className={`${th} text-right`}>SGST</th>
                    </>
                  ) : (
                    <th className={`${th} text-right`}>IGST</th>
                  )}
                  <th className={`${th} text-right`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.lineNo}>
                    <td className={`${td} text-xs text-slate-500`}>{l.lineNo}</td>
                    <td className={td}>
                      <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                      {l.description}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{l.hsnCode}</td>
                    <td className={tdNum}>
                      {qty(l.quantity)} {l.uom}
                    </td>
                    <td className={tdNum}>{inr(l.unitRate)}</td>
                    <td className={tdNum}>
                      {l.discountPercent === '0' ? '—' : `${l.discountPercent}%`}
                    </td>
                    <td className={tdNum}>{inr(l.taxableAmount)}</td>
                    {intra ? (
                      <>
                        <td className={tdNum}>
                          {inr(l.cgstAmount)}{' '}
                          <span className="text-[10px] text-slate-500">{l.cgstRatePercent}%</span>
                        </td>
                        <td className={tdNum}>
                          {inr(l.sgstAmount)}{' '}
                          <span className="text-[10px] text-slate-500">{l.sgstRatePercent}%</span>
                        </td>
                      </>
                    ) : (
                      <td className={tdNum}>
                        {inr(l.igstAmount)}{' '}
                        <span className="text-[10px] text-slate-500">{l.igstRatePercent}%</span>
                      </td>
                    )}
                    <td className={`${tdNum} font-medium`}>{inr(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {inv.notes && (
              <p className="border-t border-slate-100 px-3 py-2 text-sm text-slate-600">
                Notes: {inv.notes}
              </p>
            )}
          </Panel>

          {inv.status === 'ISSUED' && (
            <Panel title="Payments">
              {inv.payments.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">No payments allocated yet.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th className={th}>Receipt</th>
                      <th className={th}>Date</th>
                      <th className={th}>Mode</th>
                      <th className={`${th} text-right`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.payments.map((p) => (
                      <tr key={p.allocationId}>
                        <td className={`${td} font-mono text-xs`}>
                          <Link
                            to="/finance/receipts/$receiptId"
                            params={{ receiptId: p.receiptId }}
                            className="hover:underline"
                          >
                            {p.receiptNumber}
                          </Link>
                        </td>
                        <td className={td}>{date(p.receiptDate)}</td>
                        <td className={td}>{PAYMENT_MODE_LABELS[p.paymentMode]}</td>
                        <td className={`${tdNum} font-medium`}>{inr(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          )}

          {(inv.status === 'ISSUED' || inv.creditNotes.length > 0) && (
            <Panel title="Credit notes">
              {inv.creditNotes.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">No credit notes against this invoice.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th className={th}>Credit note</th>
                      <th className={th}>Date</th>
                      <th className={`${th} hidden sm:table-cell`}>Reason</th>
                      <th className={th}>Status</th>
                      <th className={`${th} text-right`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.creditNotes.map((c) => (
                      <tr key={c.creditNoteId}>
                        <td className={`${td} font-mono text-xs`}>
                          <Link
                            to="/sales/credit-notes/$creditNoteId"
                            params={{ creditNoteId: c.creditNoteId }}
                            className="hover:underline"
                          >
                            {c.creditNoteNumber ?? 'Draft'}
                          </Link>
                        </td>
                        <td className={td}>{date(c.creditNoteDate)}</td>
                        <td className={`${td} hidden text-xs sm:table-cell`}>
                          {REASON_LABELS[c.reasonCode]}
                        </td>
                        <td className={td}>
                          <CreditNoteStatusBadge status={c.status} />
                        </td>
                        <td className={`${tdNum} font-medium`}>{inr(c.grandTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          )}

          {can(PERMISSIONS.auditRead) && (
            <Panel title="History (audit trail)">
              {history.isPending ? (
                <Spinner />
              ) : (
                <ol className="divide-y divide-slate-100">
                  {(history.data ?? []).map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span>{e.summary}</span>
                      <span className="text-xs text-slate-500">
                        {e.actorName ?? (e.actorKind === 'system' ? 'System' : e.actorKind)}
                        {e.actorKind === 'ai_agent' && ' (via AI)'} · {dateTime(e.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-16 xl:self-start">
          <Panel title="Totals (server-calculated)">
            <dl className="space-y-1.5 p-3 text-sm">
              <TotalRow label="Taxable value" value={inv.totals.taxableAmount} />
              {intra ? (
                <>
                  <TotalRow label="CGST" value={inv.totals.cgstAmount} />
                  <TotalRow label="SGST" value={inv.totals.sgstAmount} />
                </>
              ) : (
                <TotalRow label="IGST" value={inv.totals.igstAmount} />
              )}
              <TotalRow label="Round off" value={inv.totals.roundOff} />
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt>Grand total</dt>
                <dd className="tabular">{inr(inv.grandTotal)}</dd>
              </div>
              {inv.outstandingAmount !== null && (
                <>
                  <TotalRow label="Paid" value={inv.paidAmount} />
                  {!isZero(inv.creditedAmount) && (
                    <TotalRow label="Credited (credit notes)" value={inv.creditedAmount} />
                  )}
                  <div
                    className="flex justify-between font-semibold"
                    data-testid="invoice-outstanding"
                  >
                    <dt>Outstanding</dt>
                    <dd className={`tabular ${owes ? 'text-red-700' : 'text-emerald-700'}`}>
                      {inr(inv.outstandingAmount)}
                    </dd>
                  </div>
                </>
              )}
              {inv.status === 'CANCELLED' && (
                <div
                  className="flex justify-between font-semibold"
                  data-testid="invoice-outstanding"
                >
                  <dt>Outstanding</dt>
                  <dd>
                    <Badge>Cancelled — nothing due</Badge>
                  </dd>
                </div>
              )}
              <p className="pt-1 text-xs text-slate-500">{inv.amountInWords}</p>
              <p className="pt-1 text-[11px] text-slate-400">GST engine v{inv.calcEngineVersion}</p>
            </dl>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={confirm === 'issue'}
        onClose={() => setConfirm(null)}
        title="Issue this invoice?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={issue.isPending}
              onClick={() => issue.mutate(inv.version)}
            >
              {issue.isPending ? 'Issuing…' : `Issue for ${inr(inv.grandTotal)}`}
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>The next invoice number in the series is assigned.</li>
          <li>The invoice becomes permanent: it can no longer be edited or deleted.</li>
          <li>
            {inr(inv.grandTotal)} is added to {inv.customerName}&apos;s outstanding balance.
          </li>
          <li>GST is recalculated by the server one final time and a PDF is generated.</li>
        </ul>
        <ErrorBanner error={issue.error} className="mt-3" />
      </Dialog>

      <Dialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title={`Cancel invoice ${inv.invoiceNumber ?? ''}?`}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Keep invoice</Button>
            <Button
              variant="danger"
              disabled={!reasonValid || cancel.isPending}
              onClick={() => cancel.mutate(inv.version)}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel invoice'}
            </Button>
          </>
        }
      >
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            The invoice is kept with its number, values and PDF, marked <strong>CANCELLED</strong>.
            This cannot be undone.
          </li>
          <li>
            {inr(inv.grandTotal)} is reversed from {inv.customerName}&apos;s balance; no payment can
            be applied to it afterwards.
          </li>
          <li>
            To reduce an invoice the customer keeps (returns, discounts), issue a credit note
            instead. Whether a cancelled tax invoice needs further GST action is a CA validation
            point.
          </li>
        </ul>
        <Field
          label="Reason for cancelling"
          htmlFor="cancel-reason"
          error={cancelReason !== '' && !reasonValid ? 'At least 3 characters' : undefined}
          hint="Kept in the invoice record and the audit trail"
        >
          <Input
            id="cancel-reason"
            autoFocus
            maxLength={500}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reasonValid && !cancel.isPending) cancel.mutate(inv.version);
            }}
          />
        </Field>
        <ErrorBanner error={cancel.error} className="mt-3" />
      </Dialog>

      <Dialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this draft?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(inv.version)}
            >
              Delete draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          The draft is removed. This is recorded in the audit trail.
        </p>
      </Dialog>
    </>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular">{inr(value)}</dd>
    </div>
  );
}

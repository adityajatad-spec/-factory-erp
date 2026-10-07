import {
  PERMISSIONS,
  type AuditEventDto,
  type CompanyDto,
  type CreditNoteDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
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
import { api } from '../../lib/api';
import { date, dateTime, inr, qty } from '../../lib/format';
import { useCan } from '../../lib/session';
import { CreditNoteStatusBadge, REASON_LABELS } from './labels';

export function CreditNoteDetailPage() {
  const { creditNoteId } = useParams({ from: '/app/sales/credit-notes/$creditNoteId' });
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'issue' | 'delete' | null>(null);

  const creditNote = useQuery({
    queryKey: ['credit-note', creditNoteId],
    queryFn: () => api.get<CreditNoteDto>(`/credit-notes/${creditNoteId}`),
    // The PDF is produced asynchronously by the outbox worker after issue.
    refetchInterval: (q) =>
      q.state.data?.status === 'ISSUED' && !q.state.data.pdfDocumentId ? 1500 : false,
  });
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyDto>('/company'),
    staleTime: 10 * 60_000,
  });
  const history = useQuery({
    queryKey: [
      'audit',
      'sales.credit_note',
      creditNoteId,
      creditNote.data?.version,
      creditNote.data?.pdfDocumentId,
    ],
    queryFn: () =>
      api.get<AuditEventDto[]>('/audit-events', {
        entityType: 'sales.credit_note',
        entityId: creditNoteId,
      }),
    enabled: can(PERMISSIONS.auditRead),
  });

  const refresh = async (updated?: CreditNoteDto) => {
    if (updated) queryClient.setQueryData(['credit-note', creditNoteId], updated);
    await Promise.all(
      ['credit-notes', 'invoice', 'invoices', 'receivables', 'dashboard', 'audit'].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
  };
  const issue = useMutation({
    mutationFn: (version: number) =>
      api.post<CreditNoteDto>(`/credit-notes/${creditNoteId}/issue`, { expectedVersion: version }),
    onSuccess: async (updated) => {
      setConfirm(null);
      await refresh(updated);
    },
  });
  const remove = useMutation({
    mutationFn: (version: number) =>
      api.del<unknown>(`/credit-notes/${creditNoteId}`, { expectedVersion: version }),
    onSuccess: async () => {
      setConfirm(null);
      queryClient.removeQueries({ queryKey: ['credit-note', creditNoteId] });
      await refresh();
      await navigate({ to: '/sales/credit-notes' });
    },
  });

  if (creditNote.isPending) return <Spinner />;
  if (creditNote.error) return <ErrorBanner error={creditNote.error} />;
  const cn = creditNote.data;
  const intra = cn.supplyType === 'INTRA_STATE';
  const specimen = company.data && company.data.financeReadiness !== 'PRODUCTION';
  const pdfUrl = cn.pdfDocumentId ? `/api/v1/documents/${cn.pdfDocumentId}/content` : null;
  const invoiceLink = (
    <Link
      to="/sales/invoices/$invoiceId"
      params={{ invoiceId: cn.invoiceId }}
      className="font-mono underline"
    >
      {cn.invoiceNumber}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {cn.creditNoteNumber ?? 'Draft credit note'}{' '}
            <CreditNoteStatusBadge status={cn.status} />
          </span>
        }
        subtitle={
          <>
            {cn.customerName} · {date(cn.creditNoteDate)} · against {invoiceLink} dated{' '}
            {date(cn.invoiceDate)} · {intra ? 'CGST + SGST' : 'IGST'}
          </>
        }
        actions={
          cn.status === 'DRAFT' ? (
            <>
              {can(PERMISSIONS.creditNoteDraft) && (
                <>
                  <Button variant="danger" onClick={() => setConfirm('delete')}>
                    Delete draft
                  </Button>
                  <Link to="/sales/credit-notes/$creditNoteId/edit" params={{ creditNoteId }}>
                    <Button>Edit</Button>
                  </Link>
                </>
              )}
              {can(PERMISSIONS.creditNoteIssue) && (
                <Button variant="primary" onClick={() => setConfirm('issue')}>
                  Issue credit note…
                </Button>
              )}
            </>
          ) : pdfUrl ? (
            <>
              <a href={pdfUrl} target="_blank" rel="noreferrer">
                <Button variant="primary">Open PDF</Button>
              </a>
              <a href={`${pdfUrl}?download=1`}>
                <Button>Download</Button>
              </a>
            </>
          ) : (
            <span className="text-sm text-slate-500">Generating PDF…</span>
          )
        }
      />

      {cn.status === 'ISSUED' && specimen && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Specimen mode: GST calculations have not yet been validated by a chartered accountant, so
          issued PDFs are watermarked “SPECIMEN — not a valid credit note”.
        </div>
      )}
      <ErrorBanner error={issue.error ?? remove.error} className="mb-3" />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Panel title="Reason">
            <div className="space-y-1 p-3 text-sm">
              <p>
                <span className="font-medium">{REASON_LABELS[cn.reasonCode]}</span> — {cn.reason}
              </p>
              {cn.notes && <p className="text-slate-600">Notes: {cn.notes}</p>}
            </div>
          </Panel>

          <Panel title="Lines">
            <Table>
              <thead>
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>Description</th>
                  <th className={`${th} hidden md:table-cell`}>Invoice line</th>
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
                {cn.lines.map((l) => (
                  <tr key={l.lineNo}>
                    <td className={`${td} text-xs text-slate-500`}>{l.lineNo}</td>
                    <td className={td}>
                      <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                      {l.description}
                      <span className="ml-1 font-mono text-[11px] text-slate-400">
                        HSN {l.hsnCode}
                      </span>
                    </td>
                    <td className={`${td} hidden text-xs text-slate-500 md:table-cell`}>
                      #{l.invoiceLineNo}
                    </td>
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
                        <td className={tdNum}>{inr(l.cgstAmount)}</td>
                        <td className={tdNum}>{inr(l.sgstAmount)}</td>
                      </>
                    ) : (
                      <td className={tdNum}>{inr(l.igstAmount)}</td>
                    )}
                    <td className={`${tdNum} font-medium`}>{inr(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>

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
              <TotalRow label="Taxable value" value={cn.totals.taxableAmount} />
              {intra ? (
                <>
                  <TotalRow label="CGST" value={cn.totals.cgstAmount} />
                  <TotalRow label="SGST" value={cn.totals.sgstAmount} />
                </>
              ) : (
                <TotalRow label="IGST" value={cn.totals.igstAmount} />
              )}
              <TotalRow label="Round off" value={cn.totals.roundOff} />
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt>Credit note total</dt>
                <dd className="tabular">{inr(cn.grandTotal)}</dd>
              </div>
              <p className="pt-1 text-xs text-slate-500">{cn.amountInWords}</p>
              <p className="pt-1 text-[11px] text-slate-400">GST engine v{cn.calcEngineVersion}</p>
            </dl>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={confirm === 'issue'}
        onClose={() => setConfirm(null)}
        title="Issue this credit note?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={issue.isPending}
              onClick={() => issue.mutate(cn.version)}
            >
              {issue.isPending ? 'Issuing…' : `Issue for ${inr(cn.grandTotal)}`}
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>The next credit note number in the series is assigned.</li>
          <li>The credit note becomes permanent: it can no longer be edited or deleted.</li>
          <li>
            {cn.invoiceNumber}&apos;s outstanding and {cn.customerName}&apos;s balance go down by{' '}
            {inr(cn.grandTotal)}.
          </li>
          <li>Everything is checked and recalculated by the server, and a PDF is generated.</li>
        </ul>
        <ErrorBanner error={issue.error} className="mt-3" />
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
              onClick={() => remove.mutate(cn.version)}
            >
              Delete draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          The draft is removed; nothing was credited yet. This is recorded in the audit trail.
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

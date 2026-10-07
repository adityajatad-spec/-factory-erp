import {
  CREDIT_NOTE_REASONS,
  PERMISSIONS,
  type CreditNoteDto,
  type CreditNoteReason,
  type InvoiceDto,
  type InvoiceListItemDto,
  type PartyDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
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
import { Field, Input, Select } from '../../components/field';
import { api } from '../../lib/api';
import { date, inr, qty, todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { matches } from '../invoices/use-invoice-masters';
import { previewCreditNote, type CreditInput } from './credit-math';
import { REASON_LABELS } from './labels';

export function CreditNoteEditorPage() {
  const { creditNoteId } = useParams({ strict: false });
  const search: { invoiceId?: string } = useSearch({ strict: false });
  const existing = useQuery({
    queryKey: ['credit-note', creditNoteId],
    queryFn: () => api.get<CreditNoteDto>(`/credit-notes/${creditNoteId ?? ''}`),
    enabled: !!creditNoteId,
  });
  const invoiceId = existing.data?.invoiceId ?? search.invoiceId;
  const invoice = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDto>(`/sales-invoices/${invoiceId ?? ''}`),
    enabled: !!invoiceId,
  });

  if (creditNoteId && existing.isPending) return <Spinner />;
  if (existing.error) return <ErrorBanner error={existing.error} />;
  if (existing.data && existing.data.status !== 'DRAFT')
    return <ErrorBanner error={new Error('Only draft credit notes can be edited')} />;
  if (!invoiceId) return <InvoicePicker />;
  if (invoice.isPending) return <Spinner />;
  if (invoice.error) return <ErrorBanner error={invoice.error} />;
  if (invoice.data.status !== 'ISSUED')
    return (
      <ErrorBanner
        error={
          new Error(`Only issued invoices can be credited (this one is ${invoice.data.status})`)
        }
      />
    );

  return (
    <CreditNoteForm
      key={creditNoteId ?? invoiceId}
      invoice={invoice.data}
      existing={existing.data ?? null}
    />
  );
}

/** Step 1 when started without an invoice: pick the customer, then one of their open invoices. */
function InvoicePicker() {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<PartyDto | null>(null);
  const [query, setQuery] = useState('');
  const customers = useQuery({
    queryKey: ['parties', 'customers-all'],
    queryFn: () => api.get<PartyDto[]>('/parties', { role: 'customer', limit: 200 }),
  });
  const invoices = useQuery({
    queryKey: ['invoices', 'creditable', customer?.id],
    queryFn: () =>
      api.get<InvoiceListItemDto[]>('/sales-invoices', {
        customerId: customer?.id,
        status: 'ISSUED',
        limit: 200,
      }),
    enabled: !!customer,
  });
  const open = (invoices.data ?? []).filter(
    (i) => i.outstandingAmount !== null && !/^0+(\.0+)?$/.test(i.outstandingAmount),
  );

  return (
    <>
      <PageHeader
        title="New credit note"
        subtitle="A credit note always credits one issued invoice. Choose the customer and the invoice."
      />
      <Panel title="Invoice to credit">
        <div className="max-w-md p-3">
          <Field label="Customer" htmlFor="cn-customer">
            <Combobox
              inputId="cn-customer"
              autoFocus
              options={(customers.data ?? [])
                .filter((c) => matches(query, c.name, c.code, c.gstin))
                .slice(0, 50)}
              value={customer}
              query={query}
              onQueryChange={setQuery}
              onSelect={setCustomer}
              getKey={(c) => c.id}
              getLabel={(c) => c.name}
              placeholder="Search customer"
            />
          </Field>
        </div>
        <ErrorBanner error={customers.error ?? invoices.error} className="m-3" />
        {customer &&
          (invoices.isPending ? (
            <Spinner />
          ) : open.length === 0 ? (
            <EmptyState title="No invoices with an outstanding amount">
              Only issued invoices that still have something outstanding can be credited.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Invoice</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>Grand total</th>
                  <th className={`${th} text-right`}>Outstanding</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td className={`${td} font-mono text-xs`}>{i.invoiceNumber}</td>
                    <td className={td}>{date(i.invoiceDate)}</td>
                    <td className={tdNum}>{inr(i.grandTotal)}</td>
                    <td className={tdNum}>{inr(i.outstandingAmount)}</td>
                    <td className={`${td} text-right`}>
                      <Button
                        size="sm"
                        onClick={() =>
                          void navigate({
                            to: '/sales/credit-notes/new',
                            search: { invoiceId: i.id },
                          })
                        }
                      >
                        Credit {i.invoiceNumber}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ))}
      </Panel>
    </>
  );
}

function CreditNoteForm({
  invoice,
  existing,
}: {
  invoice: InvoiceDto;
  existing: CreditNoteDto | null;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creditNoteDate, setCreditNoteDate] = useState(existing?.creditNoteDate ?? todayIST());
  const [reasonCode, setReasonCode] = useState<CreditNoteReason>(
    existing?.reasonCode ?? 'SALES_RETURN',
  );
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [inputs, setInputs] = useState<Map<number, CreditInput>>(() => {
    const m = new Map<number, CreditInput>(
      invoice.lines.map((l) => [l.lineNo, { quantity: '', unitRate: qty(l.unitRate) }]),
    );
    for (const l of existing?.lines ?? [])
      m.set(l.invoiceLineNo, { quantity: qty(l.quantity), unitRate: qty(l.unitRate) });
    return m;
  });

  const preview = useMemo(
    () =>
      previewCreditNote(
        {
          supplierStateCode: invoice.supplierStateCode,
          placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
          invoiceRounding: invoice.invoiceRounding,
          outstandingAmount: invoice.outstandingAmount ?? '0',
          lines: invoice.lines,
        },
        inputs,
      ),
    [invoice, inputs],
  );
  const intra = invoice.supplyType === 'INTRA_STATE';
  const nothingCreditedYet = invoice.lines.every((l) =>
    /^0+(\.0+)?$/.test(l.creditedTaxableAmount),
  );
  const reasonValid = reason.trim().length >= 3;
  const canSave =
    preview.lines.length > 0 &&
    preview.totalError === null &&
    reasonValid &&
    can(PERMISSIONS.creditNoteDraft);

  const setLine = (lineNo: number, patch: Partial<CreditInput>) =>
    setInputs((prev) => {
      const next = new Map(prev);
      const cur = next.get(lineNo) ?? { quantity: '', unitRate: '' };
      next.set(lineNo, { ...cur, ...patch });
      return next;
    });

  const body = () => ({
    creditNoteDate,
    reasonCode,
    reason: reason.trim(),
    notes: notes.trim() || null,
    lines: preview.lines,
  });
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.put<CreditNoteDto>(`/credit-notes/${existing.id}`, {
            ...body(),
            expectedVersion: existing.version,
          })
        : api.post<CreditNoteDto>(`/sales-invoices/${invoice.id}/credit-notes`, {
            ...body(),
            customerId: invoice.customerId,
          }),
    onSuccess: async (cn) => {
      queryClient.setQueryData(['credit-note', cn.id], cn);
      await queryClient.invalidateQueries({ queryKey: ['credit-notes'] });
      await navigate({ to: '/sales/credit-notes/$creditNoteId', params: { creditNoteId: cn.id } });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave && !save.isPending) {
        e.preventDefault();
        save.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave, save]);

  const totals = preview.result?.totals;
  return (
    <>
      <PageHeader
        title={existing ? 'Edit credit note draft' : 'New credit note'}
        subtitle={
          <>
            Against{' '}
            <Link
              to="/sales/invoices/$invoiceId"
              params={{ invoiceId: invoice.id }}
              className="font-mono underline"
            >
              {invoice.invoiceNumber}
            </Link>{' '}
            · {invoice.customerName} · {date(invoice.invoiceDate)} · outstanding{' '}
            {inr(invoice.outstandingAmount)}
          </>
        }
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              shortcut="Ctrl ↵"
              disabled={!canSave || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </>
        }
      />
      <ErrorBanner error={save.error} className="mb-3" />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Panel title="Credit note">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Credit note date" htmlFor="cn-date">
                <Input
                  id="cn-date"
                  type="date"
                  value={creditNoteDate}
                  min={invoice.invoiceDate}
                  max={todayIST()}
                  onChange={(e) => setCreditNoteDate(e.target.value)}
                />
              </Field>
              <Field label="Reason" htmlFor="cn-reason-code" hint="[VERIFY R-03] with your CA">
                <Select
                  id="cn-reason-code"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as CreditNoteReason)}
                >
                  {CREDIT_NOTE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field
                  label="Reason details"
                  htmlFor="cn-reason"
                  error={reason !== '' && !reasonValid ? 'At least 3 characters' : undefined}
                  hint="Printed on the credit note and kept in the audit trail"
                >
                  <Input
                    id="cn-reason"
                    value={reason}
                    maxLength={500}
                    autoFocus
                    placeholder="e.g. 10 units returned damaged"
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <Field label="Notes (optional)" htmlFor="cn-notes">
                  <Input
                    id="cn-notes"
                    value={notes}
                    maxLength={1000}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel
            title="Lines to credit"
            actions={
              <Button
                size="sm"
                disabled={!nothingCreditedYet}
                title={
                  nothingCreditedYet
                    ? 'Credit every line in full (quantity and rate as invoiced)'
                    : 'Part of this invoice is already credited'
                }
                onClick={() =>
                  setInputs(
                    new Map(
                      invoice.lines.map((l) => [
                        l.lineNo,
                        { quantity: qty(l.quantity), unitRate: qty(l.unitRate) },
                      ]),
                    ),
                  )
                }
              >
                Credit full invoice
              </Button>
            }
          >
            <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
              For a return, enter the quantity returned at the invoiced rate. For a price reduction,
              enter the quantity affected and the reduction per unit. Each line keeps its invoiced
              discount and GST rate.
            </p>
            <Table>
              <thead>
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Invoiced</th>
                  <th className={`${th} hidden text-right md:table-cell`}>Already credited</th>
                  <th className={`${th} text-right`}>Credit qty</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Taxable</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((l) => {
                  const input = inputs.get(l.lineNo) ?? { quantity: '', unitRate: '' };
                  const error = preview.lineErrors.get(l.lineNo);
                  const idx = preview.lines.findIndex((x) => x.invoiceLineNo === l.lineNo);
                  const priced = idx >= 0 ? preview.result?.lines[idx] : undefined;
                  return (
                    <tr key={l.lineNo} className={error ? 'bg-red-50' : ''}>
                      <td className={`${td} text-xs text-slate-500`}>{l.lineNo}</td>
                      <td className={td}>
                        <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                        {l.description}
                        <div className="text-[11px] text-slate-500">
                          GST {l.gstRatePercent}%
                          {l.discountPercent !== '0' && ` · discount ${l.discountPercent}%`}
                        </div>
                        {error && <div className="text-xs text-red-700">{error}</div>}
                      </td>
                      <td className={tdNum}>
                        {qty(l.quantity)} {l.uom} × {inr(l.unitRate)}
                        <div className="text-[11px] text-slate-500">{inr(l.taxableAmount)}</div>
                      </td>
                      <td className={`${tdNum} hidden md:table-cell`}>
                        {/^0+(\.0+)?$/.test(l.creditedTaxableAmount)
                          ? '—'
                          : inr(l.creditedTaxableAmount)}
                      </td>
                      <td className={`${td} w-24`}>
                        <Input
                          aria-label={`Credit quantity for line ${l.lineNo}`}
                          inputMode="decimal"
                          className="text-right tabular"
                          value={input.quantity}
                          placeholder="0"
                          onChange={(e) => setLine(l.lineNo, { quantity: e.target.value })}
                        />
                      </td>
                      <td className={`${td} w-28`}>
                        <Input
                          aria-label={`Credit rate for line ${l.lineNo}`}
                          inputMode="decimal"
                          className="text-right tabular"
                          value={input.unitRate}
                          onChange={(e) => setLine(l.lineNo, { unitRate: e.target.value })}
                        />
                      </td>
                      <td className={tdNum}>{priced ? inr(priced.taxableAmount) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Panel>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-16 xl:self-start">
          <Panel title="Credit (preview)">
            <dl className="space-y-1.5 p-3 text-sm">
              <Row label="Taxable value" value={totals?.taxableAmount} />
              {intra ? (
                <>
                  <Row label="CGST" value={totals?.cgstAmount} />
                  <Row label="SGST" value={totals?.sgstAmount} />
                </>
              ) : (
                <Row label="IGST" value={totals?.igstAmount} />
              )}
              <Row label="Round off" value={totals?.roundOff} />
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt>Credit note total</dt>
                <dd className="tabular" data-testid="credit-total">
                  {inr(totals?.grandTotal)}
                </dd>
              </div>
              <Row label="Invoice outstanding now" value={invoice.outstandingAmount} />
              <Row label="Outstanding after credit" value={preview.outstandingAfter} />
              {preview.totalError && (
                <p role="alert" className="pt-1 text-xs font-medium text-red-700">
                  {preview.totalError}
                </p>
              )}
              <p className="pt-1 text-[11px] text-slate-400">
                Preview only — the server recalculates on save and again on issue.
              </p>
            </dl>
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular">{inr(value)}</dd>
    </div>
  );
}

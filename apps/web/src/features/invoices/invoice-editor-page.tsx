import { PERMISSIONS, type InvoiceDto, type ItemDto, type PartyDto } from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import { Badge, ErrorBanner, PageHeader, Panel, Spinner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { inr, qty, todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { LinesEditor, newLine, type EditorLine } from './lines-editor';
import { previewInvoice } from './preview';
import { matches, useInvoiceMasters } from './use-invoice-masters';

export function InvoiceEditorPage() {
  const params = useParams({ strict: false });
  const invoiceId = params.invoiceId;
  const existing = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDto>(`/sales-invoices/${invoiceId ?? ''}`),
    enabled: !!invoiceId,
  });
  const masters = useInvoiceMasters();

  if (
    (invoiceId && existing.isPending) ||
    masters.customers.isPending ||
    masters.items.isPending ||
    masters.company.isPending
  )
    return <Spinner />;
  const error =
    existing.error ?? masters.customers.error ?? masters.items.error ?? masters.company.error;
  if (error) return <ErrorBanner error={error} />;
  if (existing.data && existing.data.status !== 'DRAFT')
    return <ErrorBanner error={new Error('Only draft invoices can be edited')} />;

  return (
    <InvoiceForm
      key={invoiceId ?? 'new'}
      existing={existing.data ?? null}
      customers={masters.customers.data ?? []}
      items={masters.items.data ?? []}
    />
  );
}

function InvoiceForm({
  existing,
  customers,
  items,
}: {
  existing: InvoiceDto | null;
  customers: PartyDto[];
  items: ItemDto[];
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { company, states } = useInvoiceMasters();
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const [customer, setCustomer] = useState<PartyDto | null>(
    () => customers.find((c) => c.id === existing?.customerId) ?? null,
  );
  const [customerQuery, setCustomerQuery] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(existing?.invoiceDate ?? todayIST());
  const [placeOfSupply, setPlaceOfSupply] = useState(existing?.placeOfSupplyStateCode ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [lines, setLines] = useState<EditorLine[]>(() =>
    existing
      ? existing.lines.map((l) => ({
          ...newLine(),
          item: itemsById.get(l.itemId) ?? null,
          quantity: qty(l.quantity),
          unitRate: qty(l.unitRate),
          discountPercent: l.discountPercent === '0' ? '' : l.discountPercent,
        }))
      : [newLine()],
  );

  const preview = previewInvoice({
    supplierStateCode: company.data?.stateCode,
    placeOfSupplyStateCode: placeOfSupply || customer?.stateCode,
    lines: lines
      .filter((l) => l.item)
      .map((l) => ({
        quantity: l.quantity,
        unitRate: l.unitRate,
        discountPercent: l.discountPercent,
        gstRatePercent: l.item?.gstRatePercent ?? null,
      })),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        customerId: customer?.id,
        invoiceDate,
        ...(placeOfSupply ? { placeOfSupplyStateCode: placeOfSupply } : {}),
        notes: notes || null,
        lines: lines
          .filter((l) => l.item)
          .map((l) => ({
            itemId: l.item?.id,
            quantity: l.quantity.trim(),
            unitRate: l.unitRate.trim(),
            discountPercent: l.discountPercent.trim() || '0',
          })),
      };
      return existing
        ? api.put<InvoiceDto>(`/sales-invoices/${existing.id}`, {
            ...body,
            expectedVersion: existing.version,
          })
        : api.post<InvoiceDto>('/sales-invoices', body);
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(['invoice', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      await navigate({ to: '/sales/invoices/$invoiceId', params: { invoiceId: saved.id } });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !save.isPending) {
        e.preventDefault();
        save.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const customerOptions = customers
    .filter((c) => matches(customerQuery, c.name, c.code, c.gstin))
    .slice(0, 50);
  const posState = placeOfSupply || customer?.stateCode;
  const intra = posState !== undefined && posState === company.data?.stateCode;

  return (
    <>
      <PageHeader
        title={existing ? 'Edit draft invoice' : 'New sales invoice'}
        subtitle="Totals shown here are a preview. The server recalculates GST from its own item and rate data when you save and again when you issue."
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              shortcut="Ctrl ↵"
              disabled={save.isPending || !can(PERMISSIONS.salesInvoiceDraft)}
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
          <Panel title="Customer & dates">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Customer" htmlFor="customer">
                  <Combobox
                    inputId="customer"
                    autoFocus={!existing}
                    options={customerOptions}
                    value={customer}
                    query={customerQuery}
                    onQueryChange={setCustomerQuery}
                    onSelect={(c) => {
                      setCustomer(c);
                      setPlaceOfSupply('');
                    }}
                    getKey={(c) => c.id}
                    getLabel={(c) => c.name}
                    placeholder="Search name, code or GSTIN"
                    renderOption={(c) => (
                      <div className="flex justify-between gap-3">
                        <span className="truncate">{c.name}</span>
                        <span className="shrink-0 font-mono text-xs text-slate-500">
                          {c.gstin ?? 'Unregistered'}
                        </span>
                      </div>
                    )}
                  />
                </Field>
              </div>
              <Field label="Invoice date" htmlFor="invoice-date">
                <Input
                  id="invoice-date"
                  type="date"
                  value={invoiceDate}
                  max={todayIST()}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </Field>
              <Field
                label="Place of supply"
                htmlFor="pos"
                hint={customer && !placeOfSupply ? "Defaults to customer's state" : undefined}
              >
                <Select
                  id="pos"
                  value={placeOfSupply}
                  onChange={(e) => setPlaceOfSupply(e.target.value)}
                >
                  <option value="">
                    {customer ? `${customer.stateName} (${customer.stateCode})` : '—'}
                  </option>
                  {(states.data ?? []).map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {customer && (
              <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                {customer.gstin ? `GSTIN ${customer.gstin}` : 'Unregistered customer'} ·{' '}
                {intra ? 'Intra-state supply → CGST + SGST' : 'Inter-state supply → IGST'}
              </p>
            )}
          </Panel>

          <Panel
            title="Lines"
            actions={
              <Button size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <IconPlus /> Add line
              </Button>
            }
          >
            <LinesEditor
              lines={lines}
              setLines={setLines}
              items={items}
              preview={preview.ok ? preview.result : null}
              intra={intra}
            />
          </Panel>

          <Panel title="Notes">
            <div className="p-3">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={1000}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
                placeholder="Optional note printed on the invoice"
              />
            </div>
          </Panel>
        </div>

        <aside className="xl:sticky xl:top-16 xl:self-start">
          <Panel
            title={
              <span className="flex items-center gap-2">
                Totals <Badge tone="blue">Preview</Badge>
              </span>
            }
          >
            {preview.ok ? (
              <dl className="space-y-1.5 p-3 text-sm">
                <Row label="Taxable value" value={preview.result.totals.taxableAmount} />
                {preview.result.supplyType === 'INTRA_STATE' ? (
                  <>
                    <Row label="CGST" value={preview.result.totals.cgstAmount} />
                    <Row label="SGST" value={preview.result.totals.sgstAmount} />
                  </>
                ) : (
                  <Row label="IGST" value={preview.result.totals.igstAmount} />
                )}
                <Row label="Round off" value={preview.result.totals.roundOff} />
                <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                  <dt>Grand total</dt>
                  <dd className="tabular">{inr(preview.result.totals.grandTotal)}</dd>
                </div>
                <p className="pt-1 text-xs text-slate-500">{preview.result.amountInWords}</p>
              </dl>
            ) : (
              <p className="p-3 text-sm text-slate-500">
                {preview.message ?? 'Choose a customer and add a line to see totals.'}
              </p>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular">{inr(value)}</dd>
    </div>
  );
}

import {
  PERMISSIONS,
  type CompanyDto,
  type ItemDto,
  type PartyDto,
  type PurchaseOrderDto,
  type WarehouseDto,
} from '@factory-erp/contracts';
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
import { LinesEditor, newLine, type EditorLine } from '../invoices/lines-editor';
import { previewInvoice } from '../invoices/preview';
import { matches } from '../invoices/use-invoice-masters';
import { usePurchasableItems, useSuppliers, useWarehouses } from './shared';

export function PurchaseOrderEditorPage() {
  const params = useParams({ strict: false });
  const orderId = params.orderId;
  const existing = useQuery({
    queryKey: ['purchase-order', orderId],
    queryFn: () => api.get<PurchaseOrderDto>(`/purchase-orders/${orderId ?? ''}`),
    enabled: !!orderId,
  });
  const suppliers = useSuppliers();
  const items = usePurchasableItems();
  const warehouses = useWarehouses();
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyDto>('/company'),
    staleTime: 10 * 60_000,
  });

  if (
    (orderId && existing.isPending) ||
    suppliers.isPending ||
    items.isPending ||
    warehouses.isPending ||
    company.isPending
  )
    return <Spinner />;
  const error =
    existing.error ?? suppliers.error ?? items.error ?? warehouses.error ?? company.error;
  if (error) return <ErrorBanner error={error} />;
  if (existing.data && existing.data.status !== 'DRAFT')
    return <ErrorBanner error={new Error('Only draft purchase orders can be edited')} />;

  return (
    <PurchaseOrderForm
      key={orderId ?? 'new'}
      existing={existing.data ?? null}
      suppliers={suppliers.data ?? []}
      items={items.data ?? []}
      warehouses={(warehouses.data ?? []).filter((w) => w.status === 'ACTIVE')}
      companyState={company.data?.stateCode}
    />
  );
}

function PurchaseOrderForm({
  existing,
  suppliers,
  items,
  warehouses,
  companyState,
}: {
  existing: PurchaseOrderDto | null;
  suppliers: PartyDto[];
  items: ItemDto[];
  warehouses: WarehouseDto[];
  companyState: string | undefined;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const [supplier, setSupplier] = useState<PartyDto | null>(
    () => suppliers.find((s) => s.id === existing?.supplierId) ?? null,
  );
  const [supplierQuery, setSupplierQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState(existing?.warehouseId ?? warehouses[0]?.id ?? '');
  const [poDate, setPoDate] = useState(existing?.poDate ?? todayIST());
  const [expectedDate, setExpectedDate] = useState(existing?.expectedDate ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [lines, setLines] = useState<EditorLine[]>(() =>
    existing
      ? existing.lines.map((l) => ({
          ...newLine(),
          item: itemsById.get(l.itemId) ?? null,
          quantity: qty(l.quantity),
          unitRate: qty(l.unitRate),
          discountPercent: l.discountPercent === '0.000' ? '' : qty(l.discountPercent),
        }))
      : [newLine()],
  );

  // Goods are delivered to us: the supplier's state against ours decides CGST+SGST vs IGST.
  const preview = previewInvoice({
    supplierStateCode: supplier?.stateCode,
    placeOfSupplyStateCode: companyState,
    lines: lines
      .filter((l) => l.item)
      .map((l) => ({
        quantity: l.quantity,
        unitRate: l.unitRate,
        discountPercent: l.discountPercent,
        gstRatePercent: l.item?.gstRatePercent ?? null,
      })),
  });
  const intra = !!supplier && supplier.stateCode === companyState;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        supplierId: supplier?.id,
        warehouseId,
        poDate,
        expectedDate: expectedDate || null,
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
        ? api.put<PurchaseOrderDto>(`/purchase-orders/${existing.id}`, {
            ...body,
            expectedVersion: existing.version,
          })
        : api.post<PurchaseOrderDto>('/purchase-orders', body);
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(['purchase-order', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      await navigate({ to: '/purchasing/orders/$orderId', params: { orderId: saved.id } });
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

  const supplierOptions = suppliers
    .filter((s) => matches(supplierQuery, s.name, s.code, s.gstin))
    .slice(0, 50);

  return (
    <>
      <PageHeader
        title={existing ? 'Edit draft purchase order' : 'New purchase order'}
        subtitle="Totals here are a preview. The server prices the order with the shared GST engine when you save and again when it is approved."
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              shortcut="Ctrl ↵"
              disabled={save.isPending || !can(PERMISSIONS.purchaseOrderDraft)}
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
          <Panel title="Supplier & delivery">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="sm:col-span-2">
                <Field label="Supplier" htmlFor="supplier">
                  <Combobox
                    inputId="supplier"
                    autoFocus={!existing}
                    options={supplierOptions}
                    value={supplier}
                    query={supplierQuery}
                    onQueryChange={setSupplierQuery}
                    onSelect={setSupplier}
                    getKey={(s) => s.id}
                    getLabel={(s) => s.name}
                    placeholder="Search name, code or GSTIN"
                    renderOption={(s) => (
                      <div className="flex justify-between gap-3">
                        <span className="truncate">{s.name}</span>
                        <span className="shrink-0 font-mono text-xs text-slate-500">
                          {s.gstin ?? 'Unregistered'}
                        </span>
                      </div>
                    )}
                  />
                </Field>
              </div>
              <Field label="Deliver to" htmlFor="warehouse">
                <Select
                  id="warehouse"
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.code})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="PO date" htmlFor="po-date">
                <Input
                  id="po-date"
                  type="date"
                  value={poDate}
                  max={todayIST()}
                  onChange={(e) => setPoDate(e.target.value)}
                />
              </Field>
              <Field label="Expected delivery" htmlFor="expected-date">
                <Input
                  id="expected-date"
                  type="date"
                  value={expectedDate}
                  min={poDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </Field>
            </div>
            {supplier && (
              <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                {supplier.gstin ? `GSTIN ${supplier.gstin}` : 'Unregistered supplier'} ·{' '}
                {intra ? 'Same state → CGST + SGST' : 'Other state → IGST'}
                {supplier.creditDays !== null && ` · ${supplier.creditDays} days credit`}
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
              prefillSaleRate={false}
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
                placeholder="Optional note printed on the purchase order"
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
                  <dt>Order total</dt>
                  <dd className="tabular">{inr(preview.result.totals.grandTotal)}</dd>
                </div>
              </dl>
            ) : (
              <p className="p-3 text-sm text-slate-500">
                {preview.message ?? 'Choose a supplier and add a line to see totals.'}
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

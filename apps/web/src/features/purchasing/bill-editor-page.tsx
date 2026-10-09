import {
  PERMISSIONS,
  type CompanyDto,
  type ItemDto,
  type PartyDto,
  type PurchaseInvoiceDto,
  type PurchaseOrderDto,
  type PurchaseOrderListItemDto,
} from '@factory-erp/contracts';
import { isDecimalString, Qty } from '@factory-erp/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import {
  Badge,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  td,
  tdNum,
  th,
} from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { inr, qty, todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { LinesEditor, newLine, type EditorLine } from '../invoices/lines-editor';
import { previewInvoice } from '../invoices/preview';
import { matches } from '../invoices/use-invoice-masters';
import { usePurchasableItems, useSuppliers } from './shared';

const BILLABLE = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

export function BillEditorPage() {
  const params = useParams({ strict: false });
  const search: { orderId?: string } = useSearch({ strict: false });
  const invoiceId = params.invoiceId;
  const existing = useQuery({
    queryKey: ['bill', invoiceId],
    queryFn: () => api.get<PurchaseInvoiceDto>(`/purchase-invoices/${invoiceId ?? ''}`),
    enabled: !!invoiceId,
  });
  const presetOrderId = existing.data?.orderId ?? search.orderId;
  const presetOrder = useQuery({
    queryKey: ['purchase-order', presetOrderId],
    queryFn: () => api.get<PurchaseOrderDto>(`/purchase-orders/${presetOrderId ?? ''}`),
    enabled: !!presetOrderId,
  });
  const suppliers = useSuppliers();
  const items = usePurchasableItems();
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyDto>('/company'),
    staleTime: 10 * 60_000,
  });

  if (
    (invoiceId && existing.isPending) ||
    (presetOrderId && presetOrder.isPending) ||
    suppliers.isPending ||
    items.isPending ||
    company.isPending
  )
    return <Spinner />;
  const error =
    existing.error ?? presetOrder.error ?? suppliers.error ?? items.error ?? company.error;
  if (error) return <ErrorBanner error={error} />;
  if (existing.data && existing.data.status !== 'DRAFT')
    return <ErrorBanner error={new Error('Posted bills cannot be edited')} />;

  return (
    <BillForm
      key={invoiceId ?? presetOrderId ?? 'new'}
      existing={existing.data ?? null}
      presetOrder={presetOrder.data ?? null}
      suppliers={suppliers.data ?? []}
      items={items.data ?? []}
      companyState={company.data?.stateCode}
    />
  );
}

interface OrderRow {
  include: boolean;
  quantity: string;
  unitRate: string;
  discountPercent: string;
}

/** What is still unbilled on an order line: accepted − already billed (never below zero). */
function unbilled(accepted: string, invoiced: string): string {
  const d = Qty.of(accepted).toDecimal().minus(Qty.of(invoiced).toDecimal());
  return d.isNegative() ? '0' : qty(d.toFixed(3));
}

/**
 * Rows for an order: what was received and not yet billed, at PO prices — or, when editing a
 * draft, what that draft bills.
 */
function rowsFor(
  order: PurchaseOrderDto,
  existing: PurchaseInvoiceDto | null,
): Record<number, OrderRow> {
  const billedNow = new Map(existing?.lines.map((l) => [l.orderLineNo, l]) ?? []);
  return Object.fromEntries(
    order.lines.map((l) => {
      const mine = billedNow.get(l.lineNo);
      const left = unbilled(l.acceptedQuantity, l.invoicedQuantity);
      return [
        l.lineNo,
        {
          include: mine ? true : !existing && left !== '0',
          quantity: mine ? qty(mine.quantity) : left === '0' ? '' : left,
          unitRate: qty(mine?.unitRate ?? l.unitRate),
          discountPercent: qty(mine?.discountPercent ?? l.discountPercent).replace(/^0$/, ''),
        },
      ];
    }),
  );
}

function BillForm({
  existing,
  presetOrder,
  suppliers,
  items,
  companyState,
}: {
  existing: PurchaseInvoiceDto | null;
  presetOrder: PurchaseOrderDto | null;
  suppliers: PartyDto[];
  items: ItemDto[];
  companyState: string | undefined;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const [basis, setBasis] = useState<'PO' | 'DIRECT'>(
    existing ? (existing.orderId ? 'PO' : 'DIRECT') : presetOrder ? 'PO' : 'PO',
  );
  const [supplier, setSupplier] = useState<PartyDto | null>(
    () => suppliers.find((s) => s.id === (existing?.supplierId ?? presetOrder?.supplierId)) ?? null,
  );
  const [supplierQuery, setSupplierQuery] = useState('');
  const [order, setOrder] = useState<PurchaseOrderDto | null>(presetOrder);
  const [goodsReceiptId, setGoodsReceiptId] = useState(existing?.goodsReceiptId ?? '');
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState(
    existing?.supplierInvoiceNumber ?? '',
  );
  const [invoiceDate, setInvoiceDate] = useState(existing?.invoiceDate ?? todayIST());
  const [statedTotal, setStatedTotal] = useState(existing?.supplierStatedTotal ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [rows, setRows] = useState<Record<number, OrderRow>>(() =>
    presetOrder ? rowsFor(presetOrder, existing) : {},
  );
  const [lines, setLines] = useState<EditorLine[]>(() =>
    existing && !existing.orderId
      ? existing.lines.map((l) => ({
          ...newLine(),
          item: itemsById.get(l.itemId) ?? null,
          quantity: qty(l.quantity),
          unitRate: qty(l.unitRate),
          discountPercent: l.discountPercent === '0.000' ? '' : qty(l.discountPercent),
        }))
      : [newLine()],
  );

  // Orders of the chosen supplier that bills can be entered against.
  const orders = useQuery({
    queryKey: ['purchase-orders', 'billable', supplier?.id],
    queryFn: () =>
      api.get<PurchaseOrderListItemDto[]>('/purchase-orders', {
        supplierId: supplier?.id,
        limit: 200,
      }),
    enabled: basis === 'PO' && !!supplier,
  });

  const chooseOrder = async (id: string) => {
    setGoodsReceiptId('');
    if (!id) {
      setOrder(null);
      setRows({});
      return;
    }
    const chosen = await api.get<PurchaseOrderDto>(`/purchase-orders/${id}`);
    setOrder(chosen);
    setRows(rowsFor(chosen, null));
  };

  const poLines = order
    ? order.lines
        .filter((l) => rows[l.lineNo]?.include)
        .map((l) => ({ ol: l, r: rows[l.lineNo] as OrderRow }))
    : [];
  const previewLines =
    basis === 'PO'
      ? poLines.map(({ ol, r }) => ({
          quantity: r.quantity,
          unitRate: r.unitRate,
          discountPercent: r.discountPercent,
          gstRatePercent: itemsById.get(ol.itemId)?.gstRatePercent ?? null,
        }))
      : lines
          .filter((l) => l.item)
          .map((l) => ({
            quantity: l.quantity,
            unitRate: l.unitRate,
            discountPercent: l.discountPercent,
            gstRatePercent: l.item?.gstRatePercent ?? null,
          }));
  const preview = previewInvoice({
    supplierStateCode: supplier?.stateCode,
    placeOfSupplyStateCode: companyState,
    lines: previewLines,
  });
  const intra = !!supplier && supplier.stateCode === companyState;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        supplierId: supplier?.id,
        orderId: basis === 'PO' ? (order?.id ?? null) : null,
        goodsReceiptId: basis === 'PO' && goodsReceiptId ? goodsReceiptId : null,
        supplierInvoiceNumber,
        invoiceDate,
        supplierStatedTotal: statedTotal.trim(),
        notes: notes || null,
        lines:
          basis === 'PO'
            ? poLines.map(({ ol, r }) => ({
                itemId: ol.itemId,
                orderLineNo: ol.lineNo,
                quantity: r.quantity.trim(),
                unitRate: r.unitRate.trim(),
                discountPercent: r.discountPercent.trim() || '0',
              }))
            : lines
                .filter((l) => l.item)
                .map((l) => ({
                  itemId: l.item?.id,
                  quantity: l.quantity.trim(),
                  unitRate: l.unitRate.trim(),
                  discountPercent: l.discountPercent.trim() || '0',
                })),
      };
      return existing
        ? api.put<PurchaseInvoiceDto>(`/purchase-invoices/${existing.id}`, {
            ...body,
            expectedVersion: existing.version,
          })
        : api.post<PurchaseInvoiceDto>('/purchase-invoices', body);
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(['bill', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['bills'] });
      await queryClient.invalidateQueries({ queryKey: ['purchase-order'] });
      await navigate({ to: '/purchasing/bills/$invoiceId', params: { invoiceId: saved.id } });
    },
  });

  const supplierOptions = suppliers
    .filter((s) => matches(supplierQuery, s.name, s.code, s.gstin))
    .slice(0, 50);
  const billableOrders = (orders.data ?? []).filter((o) => BILLABLE.includes(o.status));
  const setRow = (lineNo: number, patch: Partial<OrderRow>) =>
    setRows((rs) => ({ ...rs, [lineNo]: { ...(rs[lineNo] as OrderRow), ...patch } }));

  return (
    <>
      <PageHeader
        title={existing ? 'Edit draft supplier bill' : 'Enter supplier bill'}
        subtitle="Copy the bill as printed. Tax is recomputed by the server from the billed rates; the supplier's total is kept and compared when you post."
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              disabled={save.isPending || !can(PERMISSIONS.purchaseInvoiceDraft)}
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
          <Panel title="The bill">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Supplier" htmlFor="bill-supplier">
                  <Combobox
                    inputId="bill-supplier"
                    autoFocus={!existing && !presetOrder}
                    options={supplierOptions}
                    value={supplier}
                    query={supplierQuery}
                    onQueryChange={setSupplierQuery}
                    onSelect={(s) => {
                      setSupplier(s);
                      if (order && order.supplierId !== s.id) {
                        setOrder(null);
                        setRows({});
                      }
                    }}
                    getKey={(s) => s.id}
                    getLabel={(s) => s.name}
                    placeholder="Search name, code or GSTIN"
                  />
                </Field>
              </div>
              <Field label="Supplier's bill number" htmlFor="bill-no">
                <Input
                  id="bill-no"
                  value={supplierInvoiceNumber}
                  maxLength={30}
                  onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
                />
              </Field>
              <Field label="Bill date" htmlFor="bill-date">
                <Input
                  id="bill-date"
                  type="date"
                  value={invoiceDate}
                  max={todayIST()}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </Field>
              <Field label="Against" htmlFor="bill-basis">
                <Select
                  id="bill-basis"
                  value={basis}
                  disabled={!!existing}
                  onChange={(e) => setBasis(e.target.value as 'PO' | 'DIRECT')}
                >
                  <option value="PO">A purchase order (three-way match)</option>
                  <option value="DIRECT">No purchase order (direct)</option>
                </Select>
              </Field>
              {basis === 'PO' && (
                <>
                  <Field label="Purchase order" htmlFor="bill-order">
                    <Select
                      id="bill-order"
                      value={order?.id ?? ''}
                      onChange={(e) => void chooseOrder(e.target.value)}
                      disabled={!supplier}
                    >
                      <option value="">{supplier ? 'Choose…' : 'Choose a supplier first'}</option>
                      {order && !billableOrders.some((o) => o.id === order.id) && (
                        <option value={order.id}>{order.poNumber}</option>
                      )}
                      {billableOrders.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.poNumber} · {inr(o.grandTotal)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Delivery (GRN), if named" htmlFor="bill-grn">
                    <Select
                      id="bill-grn"
                      value={goodsReceiptId}
                      onChange={(e) => setGoodsReceiptId(e.target.value)}
                      disabled={!order}
                    >
                      <option value="">—</option>
                      {(order?.receipts ?? []).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.grnNumber}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              <Field
                label="Total on the bill (₹)"
                htmlFor="bill-total"
                hint={
                  preview.ok
                    ? `Computed: ${inr(preview.result.totals.grandTotal)}`
                    : 'As printed by the supplier'
                }
              >
                <Input
                  id="bill-total"
                  inputMode="decimal"
                  className="text-right tabular"
                  value={statedTotal}
                  onChange={(e) => setStatedTotal(e.target.value)}
                />
              </Field>
            </div>
          </Panel>

          {basis === 'PO' ? (
            <Panel title="Lines billed (from the order)">
              {!order ? (
                <p className="p-3 text-sm text-slate-500">
                  Choose the purchase order this bill is for.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className={`${th} w-8`} />
                        <th className={th}>Item</th>
                        <th className={`${th} text-right`}>Accepted</th>
                        <th className={`${th} text-right`}>Already billed</th>
                        <th className={`${th} w-28 text-right`}>Qty billed</th>
                        <th className={`${th} w-28 text-right`}>Rate (₹)</th>
                        <th className={`${th} w-20 text-right`}>Disc %</th>
                        <th className={`${th} text-right`}>PO rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.lines.map((l) => {
                        const r = rows[l.lineNo];
                        if (!r) return null;
                        return (
                          <tr key={l.lineNo}>
                            <td className={td}>
                              <input
                                type="checkbox"
                                aria-label={`Bill line ${l.lineNo}`}
                                checked={r.include}
                                onChange={(e) => setRow(l.lineNo, { include: e.target.checked })}
                              />
                            </td>
                            <td className={td}>
                              <span className="font-mono text-xs text-slate-500">{l.itemCode}</span>{' '}
                              {l.description}
                            </td>
                            <td className={tdNum}>
                              {qty(l.acceptedQuantity)} {l.uom}
                            </td>
                            <td className={tdNum}>{qty(l.invoicedQuantity)}</td>
                            <td className={td}>
                              <Input
                                inputMode="decimal"
                                aria-label={`Quantity billed, line ${l.lineNo}`}
                                className="text-right tabular"
                                disabled={!r.include}
                                value={r.quantity}
                                onChange={(e) => setRow(l.lineNo, { quantity: e.target.value })}
                              />
                            </td>
                            <td className={td}>
                              <Input
                                inputMode="decimal"
                                aria-label={`Billed rate, line ${l.lineNo}`}
                                className="text-right tabular"
                                disabled={!r.include}
                                value={r.unitRate}
                                onChange={(e) => setRow(l.lineNo, { unitRate: e.target.value })}
                              />
                            </td>
                            <td className={td}>
                              <Input
                                inputMode="decimal"
                                aria-label={`Discount, line ${l.lineNo}`}
                                className="text-right tabular"
                                placeholder="0"
                                disabled={!r.include}
                                value={r.discountPercent}
                                onChange={(e) =>
                                  setRow(l.lineNo, { discountPercent: e.target.value })
                                }
                              />
                            </td>
                            <td className={`${tdNum} text-slate-500`}>{inr(l.unitRate)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="px-3 py-2 text-xs text-slate-500">
                    Charges that are not on the order (freight, a substitute item) belong on a
                    direct bill. Differences are not decided here: posting shows them.
                  </p>
                </div>
              )}
            </Panel>
          ) : (
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
          )}

          <Panel title="Notes">
            <div className="p-3">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={1000}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
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
                  <dt>Computed total</dt>
                  <dd className="tabular">{inr(preview.result.totals.grandTotal)}</dd>
                </div>
                {statedTotal && isDecimalString(statedTotal.trim()) && (
                  <div className="flex justify-between text-slate-600">
                    <dt>On the bill</dt>
                    <dd className="tabular">{inr(statedTotal.trim())}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="p-3 text-sm text-slate-500">
                {preview.message ?? 'Choose a supplier and lines to see totals.'}
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

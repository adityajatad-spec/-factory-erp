import {
  PERMISSIONS,
  type ItemDto,
  type StockAdjustmentDto,
  type StockLevelDto,
  type StockMovementDto,
} from '@factory-erp/contracts';
import { isDecimalString } from '@factory-erp/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import { Dialog } from '../../components/dialog';
import {
  Badge,
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
import { date, qty, todayIST } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { matches } from '../invoices/use-invoice-masters';
import { usePurchasableItems, useWarehouses } from '../purchasing/shared';

const SOURCE_LABELS: Record<string, string> = {
  'purchase.goods_receipt': 'Goods receipt',
  'inventory.adjustment': 'Adjustment',
  'inventory.opening': 'Opening stock',
};

/**
 * Stock on hand per item and store. Every figure is the server's sum of the append-only
 * stock ledger; the browser never computes a balance.
 */
export function StockPage() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const [selected, setSelected] = useState<StockLevelDto | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const warehouses = useWarehouses();

  const stock = useQuery({
    queryKey: ['stock', debounced, warehouseId, includeZero],
    queryFn: () =>
      api.get<StockLevelDto[]>('/inventory/stock', {
        q: debounced,
        warehouseId: warehouseId || undefined,
        includeZero: includeZero ? 'true' : undefined,
        limit: 200,
      }),
  });
  const movements = useQuery({
    queryKey: ['movements', selected?.itemId, selected?.warehouseId],
    queryFn: () =>
      api.get<StockMovementDto[]>('/inventory/movements', {
        itemId: selected?.itemId,
        warehouseId: selected?.warehouseId,
        limit: 100,
      }),
    enabled: !!selected,
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );

  return (
    <>
      <PageHeader
        title="Stock"
        subtitle="Stock on hand by store, from the stock ledger. Corrections are new movements with a reason — nothing is edited."
        actions={
          can(PERMISSIONS.inventoryStockAdjust) && (
            <Button onClick={() => setAdjusting(true)}>Adjust stock</Button>
          )
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
        <Panel
          title={`${stock.data?.length ?? 0} balances`}
          actions={
            <>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={includeZero}
                  onChange={(e) => setIncludeZero(e.target.checked)}
                />
                Zero
              </label>
              <Select
                aria-label="Store"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className="w-40"
              >
                <option value="">All stores</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
              <Input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search item  ( / )"
                className="w-44 sm:w-56"
              />
            </>
          }
        >
          <ErrorBanner error={stock.error} className="m-3" />
          {stock.isPending ? (
            <Spinner />
          ) : stock.data?.length ? (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Item</th>
                  <th className={`${th} hidden md:table-cell`}>Type</th>
                  <th className={th}>Store</th>
                  <th className={`${th} text-right`}>On hand</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.map((s) => {
                  const active =
                    selected?.itemId === s.itemId && selected.warehouseId === s.warehouseId;
                  return (
                    <tr
                      key={`${s.itemId}-${s.warehouseId}`}
                      tabIndex={0}
                      onClick={() => setSelected(s)}
                      onKeyDown={(e) => e.key === 'Enter' && setSelected(s)}
                      className={`cursor-pointer hover:bg-slate-50 focus:outline-none ${active ? 'bg-accent-50' : ''}`}
                    >
                      <td className={td}>
                        <span className="font-mono text-xs text-slate-500">{s.itemCode}</span>{' '}
                        {s.itemName}
                      </td>
                      <td className={`${td} hidden text-xs text-slate-600 md:table-cell`}>
                        {s.itemType.replace('_', ' ').toLowerCase()}
                      </td>
                      <td className={`${td} font-mono text-xs`}>{s.warehouseCode}</td>
                      <td className={`${tdNum} font-medium`}>
                        {qty(s.quantity)} <span className="text-xs text-slate-500">{s.uom}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No stock found" />
          )}
        </Panel>

        <aside className="xl:sticky xl:top-16 xl:self-start">
          <Panel
            title={selected ? `${selected.itemCode} in ${selected.warehouseCode}` : 'Movements'}
          >
            {!selected ? (
              <p className="p-3 text-sm text-slate-500">Choose a balance to see its movements.</p>
            ) : movements.isPending ? (
              <Spinner />
            ) : (
              <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-auto">
                {(movements.data ?? []).map((m) => (
                  <li key={m.id} className="px-3 py-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span>
                        <Badge tone={m.quantity.startsWith('-') ? 'red' : 'green'}>
                          {m.movementType}
                        </Badge>{' '}
                        {date(m.movementDate)}
                      </span>
                      <span className="font-medium tabular">
                        {m.quantity.startsWith('-') ? '' : '+'}
                        {qty(m.quantity)} {m.uom}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {SOURCE_LABELS[m.sourceType ?? ''] ?? m.sourceType ?? '—'}
                      {m.reference ? ` · ${m.reference}` : ''}
                      {m.sourceType === 'purchase.goods_receipt' && m.sourceId && (
                        <>
                          {' · '}
                          <Link
                            to="/purchasing/receipts/$grnId"
                            params={{ grnId: m.sourceId }}
                            className="hover:underline"
                          >
                            open
                          </Link>
                        </>
                      )}
                      {m.notes ? ` · ${m.notes}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
      {adjusting && <AdjustDialog onClose={() => setAdjusting(false)} />}
    </>
  );
}

interface AdjustLine {
  key: number;
  item: ItemDto | null;
  query: string;
  quantity: string;
}

function AdjustDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const warehouses = useWarehouses();
  const items = usePurchasableItems();
  const [warehouseId, setWarehouseId] = useState('');
  const [adjustmentDate, setAdjustmentDate] = useState(todayIST());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<AdjustLine[]>([
    { key: 1, item: null, query: '', quantity: '' },
  ]);
  const stockable = (items.data ?? []).filter((i) => i.itemType !== 'SERVICE');
  const set = (key: number, patch: Partial<AdjustLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useMutation({
    mutationFn: () =>
      api.post<StockAdjustmentDto>('/inventory/adjustments', {
        warehouseId: warehouseId || warehouses.data?.[0]?.id,
        adjustmentDate,
        reason,
        lines: lines
          .filter((l) => l.item)
          .map((l) => ({ itemId: l.item?.id, quantity: l.quantity.trim() })),
      }),
    onSuccess: async () => {
      await Promise.all(
        ['stock', 'movements', 'items'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      onClose();
    },
  });
  const valid =
    reason.trim().length >= 3 &&
    lines.some((l) => l.item) &&
    lines.every((l) => !l.item || isDecimalString(l.quantity.trim()));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Adjust stock"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            Record adjustment
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} className="mb-3" />
      <p className="mb-3 text-sm text-slate-600">
        Use a positive quantity to add and a negative one to remove (e.g. -5). Stock can never go
        below zero.
      </p>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="Store" htmlFor="adj-wh">
          <Select id="adj-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" htmlFor="adj-date">
          <Input
            id="adj-date"
            type="date"
            value={adjustmentDate}
            max={todayIST()}
            onChange={(e) => setAdjustmentDate(e.target.value)}
          />
        </Field>
        <Field label="Reason" htmlFor="adj-reason">
          <Input
            id="adj-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. physical count"
          />
        </Field>
      </div>
      <div className="space-y-2">
        {lines.map((l) => (
          <div key={l.key} className="grid grid-cols-[1fr_8rem] gap-2">
            <Combobox
              options={stockable.filter((i) => matches(l.query, i.name, i.code)).slice(0, 50)}
              value={l.item}
              query={l.query}
              onQueryChange={(v) => set(l.key, { query: v })}
              onSelect={(it) => set(l.key, { item: it })}
              getKey={(i) => i.id}
              getLabel={(i) => `${i.code} · ${i.name}`}
              placeholder="Item"
            />
            <Input
              inputMode="decimal"
              aria-label="Quantity change"
              className="text-right tabular"
              placeholder="+/- qty"
              value={l.quantity}
              onChange={(e) => set(l.key, { quantity: e.target.value })}
            />
          </div>
        ))}
        <Button
          size="sm"
          onClick={() =>
            setLines((ls) => [...ls, { key: ls.length + 1, item: null, query: '', quantity: '' }])
          }
        >
          Add item
        </Button>
      </div>
    </Dialog>
  );
}

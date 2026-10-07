import { ITEM_TYPES, PERMISSIONS, type ItemDto, type ItemType } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
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
import { Input, Select } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { inr, num } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { ItemFormDialog } from './item-form';
import { ITEM_TYPE_LABELS } from './item-types';

const route = getRouteApi('/app/inventory/items');

export function ItemsPage() {
  const can = useCan();
  const search = route.useSearch();
  const [q, setQ] = useState(search.q ?? '');
  const [itemType, setItemType] = useState<ItemType | ''>('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const showStock = can(PERMISSIONS.inventoryStockRead);

  const items = useQuery({
    queryKey: ['items', 'list', debounced, itemType],
    queryFn: () =>
      api.get<ItemDto[]>('/items', { q: debounced, itemType: itemType || undefined, limit: 200 }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );

  return (
    <>
      <PageHeader
        title="Items & stock"
        subtitle="Item master with HSN codes and the GST rate in force today. Stock is derived from the append-only stock ledger."
        actions={
          can(PERMISSIONS.itemCreate) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus /> New item
            </Button>
          )
        }
      />
      <Panel
        title={`${items.data?.length ?? 0} items`}
        actions={
          <>
            <Select
              value={itemType}
              onChange={(e) => setItemType(e.target.value as ItemType | '')}
              className="w-40"
            >
              <option value="">All types</option>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search code or name  ( / )"
              className="w-48 sm:w-64"
            />
          </>
        }
      >
        <ErrorBanner error={items.error} className="m-3" />
        {items.isPending ? (
          <Spinner />
        ) : items.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Code</th>
                <th className={th}>Name</th>
                <th className={`${th} hidden md:table-cell`}>Type</th>
                <th className={th}>HSN</th>
                <th className={`${th} text-right`}>GST</th>
                <th className={`${th} hidden md:table-cell text-right`}>Sale rate</th>
                {showStock && <th className={`${th} text-right`}>On hand</th>}
              </tr>
            </thead>
            <tbody>
              {items.data.map((it) => (
                <tr key={it.id} className="hover:bg-slate-50">
                  <td className={`${td} font-mono text-xs`}>{it.code}</td>
                  <td className={`${td} font-medium`}>{it.name}</td>
                  <td className={`${td} hidden text-slate-600 md:table-cell`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{it.hsnCode}</td>
                  <td className={tdNum}>
                    {it.gstRatePercent ? (
                      `${it.gstRatePercent}%`
                    ) : (
                      <Badge tone="red">No rate</Badge>
                    )}
                    {it.gstRateStatus === 'DEMO_UNVERIFIED' && (
                      <span
                        className="ml-1"
                        title="Synthetic demo GST rate — not verified against official notifications"
                      >
                        <Badge tone="amber">demo</Badge>
                      </span>
                    )}
                  </td>
                  <td className={`${tdNum} hidden md:table-cell`}>
                    {it.defaultSaleRate ? inr(it.defaultSaleRate) : '—'}
                  </td>
                  {showStock && (
                    <td className={tdNum}>
                      {it.stockOnHand && it.stockOnHand !== '0.000'
                        ? `${num(it.stockOnHand, it.uom === 'KGS' || it.uom === 'LTR' ? 3 : 0)} ${it.uom}`
                        : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No items found" />
        )}
      </Panel>
      <ItemFormDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

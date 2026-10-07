import {
  PERMISSIONS,
  type CreditNoteListItemDto,
  type InvoiceListItemDto,
  type ItemDto,
  type PartyDto,
  type Permission,
} from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, type NavigateOptions } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { inr } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { Dialog } from '../dialog';
import { Input } from '../field';

interface Entry {
  key: string;
  label: string;
  hint?: string;
  go: NavigateOptions;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Search or jump to">
      {/* Mounted only while open, so the query resets every time the palette opens. */}
      <PaletteContent onClose={onClose} />
    </Dialog>
  );
}

function PaletteContent({ onClose }: { onClose: () => void }) {
  const can = useCan();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = useDebounced(query.trim(), 150);
  const searching = q.length >= 2;

  const invoices = useQuery({
    queryKey: ['palette', 'invoices', q],
    queryFn: () => api.get<InvoiceListItemDto[]>('/sales-invoices', { q, limit: 5 }),
    enabled: searching && can(PERMISSIONS.salesInvoiceRead),
  });
  const creditNotes = useQuery({
    queryKey: ['palette', 'credit-notes', q],
    queryFn: () => api.get<CreditNoteListItemDto[]>('/credit-notes', { q, limit: 5 }),
    enabled: searching && can(PERMISSIONS.salesInvoiceRead),
  });
  const parties = useQuery({
    queryKey: ['palette', 'parties', q],
    queryFn: () => api.get<PartyDto[]>('/parties', { q, limit: 5 }),
    enabled: searching && can(PERMISSIONS.partyRead),
  });
  const items = useQuery({
    queryKey: ['palette', 'items', q],
    queryFn: () => api.get<ItemDto[]>('/items', { q, limit: 5 }),
    enabled: searching && can(PERMISSIONS.itemRead),
  });

  const entries = useMemo(() => {
    const actions: Array<Entry & { permission: Permission }> = [
      {
        key: 'go-dash',
        label: 'Go to Dashboard',
        go: { to: '/' },
        permission: PERMISSIONS.companyRead,
      },
      {
        key: 'go-inv',
        label: 'Go to Invoices',
        go: { to: '/sales/invoices' },
        permission: PERMISSIONS.salesInvoiceRead,
      },
      {
        key: 'new-inv',
        label: 'New sales invoice',
        go: { to: '/sales/invoices/new' },
        permission: PERMISSIONS.salesInvoiceDraft,
      },
      {
        key: 'new-cn',
        label: 'New credit note',
        go: { to: '/sales/credit-notes/new' },
        permission: PERMISSIONS.creditNoteDraft,
      },
      {
        key: 'go-cn',
        label: 'Go to Credit notes',
        go: { to: '/sales/credit-notes' },
        permission: PERMISSIONS.salesInvoiceRead,
      },
      {
        key: 'new-rcpt',
        label: 'Record customer receipt',
        go: { to: '/finance/receipts/new' },
        permission: PERMISSIONS.receiptRecord,
      },
      {
        key: 'go-rcpt',
        label: 'Go to Receipts',
        go: { to: '/finance/receipts' },
        permission: PERMISSIONS.receivablesRead,
      },
      {
        key: 'go-recv',
        label: 'Go to Receivables (ageing)',
        go: { to: '/finance/receivables' },
        permission: PERMISSIONS.receivablesRead,
      },
      {
        key: 'go-cust',
        label: 'Go to Customers',
        go: { to: '/sales/customers' },
        permission: PERMISSIONS.partyRead,
      },
      {
        key: 'go-items',
        label: 'Go to Items & stock',
        go: { to: '/inventory/items' },
        permission: PERMISSIONS.itemRead,
      },
    ];
    const lower = query.trim().toLowerCase();
    const list: Entry[] = actions.filter(
      (a) => can(a.permission) && (!lower || a.label.toLowerCase().includes(lower)),
    );
    for (const i of invoices.data ?? []) {
      list.push({
        key: `inv-${i.id}`,
        label: `${i.invoiceNumber ?? 'Draft'} · ${i.customerName}`,
        hint: inr(i.grandTotal),
        go: { to: '/sales/invoices/$invoiceId', params: { invoiceId: i.id } },
      });
    }
    for (const c of creditNotes.data ?? []) {
      list.push({
        key: `cn-${c.id}`,
        label: `${c.creditNoteNumber ?? 'Draft credit note'} · ${c.customerName} (${c.invoiceNumber})`,
        hint: inr(c.grandTotal),
        go: { to: '/sales/credit-notes/$creditNoteId', params: { creditNoteId: c.id } },
      });
    }
    for (const p of parties.data ?? []) {
      list.push({
        key: `p-${p.id}`,
        label: `${p.name}`,
        hint: p.gstin ?? p.code,
        go: { to: '/sales/customers', search: { q: p.name } },
      });
    }
    for (const it of items.data ?? []) {
      list.push({
        key: `i-${it.id}`,
        label: `${it.name}`,
        hint: it.code,
        go: { to: '/inventory/items', search: { q: it.code } },
      });
    }
    return list;
  }, [query, invoices.data, creditNotes.data, parties.data, items.data, can]);

  const choose = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    void navigate(e.go);
  };

  return (
    <>
      <Input
        autoFocus
        placeholder="Invoice number, customer, item, credit note, or a command…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, entries.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(entries[active]);
          }
        }}
      />
      <ul className="mt-2 max-h-80 overflow-auto" role="listbox">
        {entries.map((e, i) => (
          <li
            key={e.key}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              choose(e);
            }}
            className={`flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm ${i === active ? 'bg-accent-50' : ''}`}
          >
            <span className="truncate">{e.label}</span>
            {e.hint && (
              <span className="ml-3 shrink-0 text-xs text-slate-500 tabular">{e.hint}</span>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="px-2 py-3 text-sm text-slate-500">No results</li>}
      </ul>
    </>
  );
}

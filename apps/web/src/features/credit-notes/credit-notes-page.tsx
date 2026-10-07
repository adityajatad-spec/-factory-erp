import { PERMISSIONS, type CreditNoteListItemDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/button';
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
import { Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { CreditNoteStatusBadge, REASON_LABELS } from './labels';

const route = getRouteApi('/app/sales/credit-notes');
const TABS = [
  { label: 'All', status: undefined },
  { label: 'Drafts', status: 'DRAFT' as const },
  { label: 'Issued', status: 'ISSUED' as const },
];

export function CreditNotesPage() {
  const can = useCan();
  const navigate = useNavigate();
  const search = route.useSearch();
  const [q, setQ] = useState(search.q ?? '');
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);

  const creditNotes = useQuery({
    queryKey: ['credit-notes', search.status, debounced],
    queryFn: () =>
      api.get<CreditNoteListItemDto[]>('/credit-notes', {
        status: search.status,
        q: debounced,
        limit: 200,
      }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  useHotkey(
    'n',
    useCallback(() => void navigate({ to: '/sales/credit-notes/new' }), [navigate]),
    can(PERMISSIONS.creditNoteDraft),
  );
  const open = (id: string) =>
    void navigate({ to: '/sales/credit-notes/$creditNoteId', params: { creditNoteId: id } });

  return (
    <>
      <PageHeader
        title="Credit notes"
        subtitle="Reductions of what a customer owes on an issued invoice — returns, discounts and price corrections. Issued credit notes are permanent."
        actions={
          can(PERMISSIONS.creditNoteDraft) && (
            <Link to="/sales/credit-notes/new">
              <Button variant="primary" shortcut="N">
                <IconPlus /> New credit note
              </Button>
            </Link>
          )
        }
      />
      <Panel
        title={
          <div className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <Link
                key={t.label}
                to="/sales/credit-notes"
                search={{ ...(t.status ? { status: t.status } : {}), ...(q ? { q } : {}) }}
                className={`rounded px-2 py-1 text-xs font-medium ${search.status === t.status ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        }
        actions={
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search number, invoice or customer  ( / )"
            className="w-56 sm:w-80"
          />
        }
      >
        <ErrorBanner error={creditNotes.error} className="m-3" />
        {creditNotes.isPending ? (
          <Spinner />
        ) : creditNotes.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Number</th>
                <th className={th}>Date</th>
                <th className={th}>Customer</th>
                <th className={`${th} hidden md:table-cell`}>Against invoice</th>
                <th className={`${th} hidden lg:table-cell`}>Reason</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {creditNotes.data.map((c) => (
                <tr
                  key={c.id}
                  tabIndex={0}
                  onClick={() => open(c.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(c.id)}
                  className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                >
                  <td className={`${td} font-mono text-xs font-medium whitespace-nowrap`}>
                    {c.creditNoteNumber ?? <span className="text-slate-400">— draft —</span>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(c.creditNoteDate)}</td>
                  <td className={`${td} max-w-64 truncate`}>{c.customerName}</td>
                  <td className={`${td} hidden font-mono text-xs md:table-cell`}>
                    {c.invoiceNumber}
                  </td>
                  <td className={`${td} hidden text-xs text-slate-600 lg:table-cell`}>
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
        ) : (
          <EmptyState title="No credit notes match">
            Credit notes are raised from an issued invoice: open the invoice and choose “Credit
            note”.
          </EmptyState>
        )}
      </Panel>
    </>
  );
}

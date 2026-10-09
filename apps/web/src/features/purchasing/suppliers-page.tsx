import { PERMISSIONS, type PartyDto, type PayablesSummaryDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
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
import { Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { inr } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { PartyFormDialog } from '../parties/party-form';

/** Suppliers are parties with the supplier role — one record per business, not a copy. */
export function SuppliersPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const suppliers = useQuery({
    queryKey: ['parties', 'suppliers', debounced],
    queryFn: () => api.get<PartyDto[]>('/parties', { q: debounced, role: 'supplier', limit: 200 }),
  });
  const payables = useQuery({
    queryKey: ['payables', 'summary'],
    queryFn: () => api.get<PayablesSummaryDto>('/payables/summary'),
    enabled: can(PERMISSIONS.payablesRead),
  });
  const owed = new Map(payables.data?.suppliers.map((s) => [s.supplierId, s]) ?? []);
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );
  const open = (id: string) =>
    void navigate({ to: '/purchasing/suppliers/$partyId', params: { partyId: id } });

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Who we buy from. Bank details are restricted and changed only with a second person's approval."
        actions={
          can(PERMISSIONS.partyCreate) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus /> New supplier
            </Button>
          )
        }
      />
      <Panel
        title={`${suppliers.data?.length ?? 0} suppliers`}
        actions={
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code, GSTIN  ( / )"
            className="w-56 sm:w-72"
          />
        }
      >
        <ErrorBanner error={suppliers.error} className="m-3" />
        {suppliers.isPending ? (
          <Spinner />
        ) : suppliers.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Code</th>
                <th className={th}>Name</th>
                <th className={th}>GSTIN</th>
                <th className={`${th} hidden md:table-cell`}>State</th>
                <th className={`${th} hidden md:table-cell text-right`}>Credit</th>
                {can(PERMISSIONS.payablesRead) && (
                  <>
                    <th className={`${th} text-right`}>We owe</th>
                    <th className={`${th} hidden text-right lg:table-cell`}>Overdue</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {suppliers.data.map((p) => {
                const s = owed.get(p.id);
                return (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    onClick={() => open(p.id)}
                    onKeyDown={(e) => e.key === 'Enter' && open(p.id)}
                    className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
                  >
                    <td className={`${td} font-mono text-xs`}>{p.code}</td>
                    <td className={`${td} font-medium`}>
                      {p.name} {p.isCustomer && <Badge tone="blue">Also customer</Badge>}
                    </td>
                    <td className={`${td} font-mono text-xs`}>
                      {p.gstin ?? <span className="text-slate-400">Unregistered</span>}
                    </td>
                    <td className={`${td} hidden md:table-cell`}>
                      {p.stateName} <span className="text-xs text-slate-400">({p.stateCode})</span>
                    </td>
                    <td className={`${tdNum} hidden md:table-cell`}>
                      {p.creditDays !== null ? `${p.creditDays} days` : '—'}
                    </td>
                    {can(PERMISSIONS.payablesRead) && (
                      <>
                        <td className={`${tdNum} font-medium`}>{s ? inr(s.balance) : '—'}</td>
                        <td className={`${tdNum} hidden lg:table-cell`}>
                          {s && s.overdueAmount !== '0.00' ? (
                            <Badge tone="red">{inr(s.overdueAmount)}</Badge>
                          ) : (
                            '—'
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No suppliers found" />
        )}
      </Panel>
      <PartyFormDialog open={creating} asSupplier onClose={() => setCreating(false)} />
    </>
  );
}

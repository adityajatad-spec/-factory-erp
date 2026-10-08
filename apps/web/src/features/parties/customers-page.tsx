import { PERMISSIONS, type PartyDto } from '@factory-erp/contracts';
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
import { inr } from '../../lib/format';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useCan } from '../../lib/session';
import { PartyFormDialog } from './party-form';

const route = getRouteApi('/app/sales/customers');

export function CustomersPage() {
  const can = useCan();
  const search = route.useSearch();
  const [q, setQ] = useState(search.q ?? '');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PartyDto | null>(null);
  const [role, setRole] = useState<'' | 'customer' | 'supplier'>('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const canEdit = can(PERMISSIONS.partyUpdate);
  const debounced = useDebounced(q.trim());
  const searchRef = useRef<HTMLInputElement>(null);
  const showBalance = can(PERMISSIONS.receivablesRead);

  const parties = useQuery({
    queryKey: ['parties', 'list', debounced, role, status],
    queryFn: () =>
      api.get<PartyDto[]>('/parties', {
        q: debounced,
        role: role || undefined,
        status,
        limit: 200,
      }),
  });
  useHotkey(
    '/',
    useCallback(() => searchRef.current?.focus(), []),
  );

  return (
    <>
      <PageHeader
        title="Customers & suppliers"
        subtitle="One record per business; a party can be a customer, a supplier, or both."
        actions={
          can(PERMISSIONS.partyCreate) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus /> New party
            </Button>
          )
        }
      />
      <Panel
        actions={
          <>
            <Select
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="w-36"
            >
              <option value="">All parties</option>
              <option value="customer">Customers</option>
              <option value="supplier">Suppliers</option>
            </Select>
            <Select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="w-32"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </Select>
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, code, GSTIN  ( / )"
              className="w-48 sm:w-64"
            />
          </>
        }
        title={`${parties.data?.length ?? 0} ${status === 'archived' ? 'archived ' : ''}parties`}
      >
        <ErrorBanner error={parties.error} className="m-3" />
        {parties.isPending ? (
          <Spinner />
        ) : parties.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Code</th>
                <th className={th}>Name</th>
                <th className={th}>Type</th>
                <th className={th}>GSTIN</th>
                <th className={`${th} hidden lg:table-cell`}>State</th>
                <th className={`${th} hidden md:table-cell`}>City</th>
                <th className={`${th} hidden lg:table-cell text-right`}>Credit</th>
                {showBalance && <th className={`${th} text-right`}>Receivable</th>}
              </tr>
            </thead>
            <tbody>
              {parties.data.map((p) => (
                <tr
                  key={p.id}
                  className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                  onClick={canEdit ? () => setEditing(p) : undefined}
                  title={canEdit ? 'Edit' : undefined}
                >
                  <td className={`${td} font-mono text-xs`}>{p.code}</td>
                  <td className={`${td} font-medium`}>{p.name}</td>
                  <td className={td}>
                    <span className="flex gap-1">
                      {p.isCustomer && <Badge tone="blue">Customer</Badge>}
                      {p.isSupplier && <Badge>Supplier</Badge>}
                      {p.status === 'ARCHIVED' && <Badge tone="neutral">Archived</Badge>}
                    </span>
                  </td>
                  <td className={`${td} font-mono text-xs`}>
                    {p.gstin ?? <span className="text-slate-400">Unregistered</span>}
                  </td>
                  <td className={`${td} hidden lg:table-cell`}>
                    {p.stateName} <span className="text-xs text-slate-400">({p.stateCode})</span>
                  </td>
                  <td className={`${td} hidden md:table-cell`}>{p.city ?? '—'}</td>
                  <td className={`${tdNum} hidden lg:table-cell`}>
                    {p.creditDays !== null ? `${p.creditDays} days` : '—'}
                  </td>
                  {showBalance && (
                    <td className={`${tdNum} font-medium`}>
                      {p.isCustomer ? inr(p.receivableBalance) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No parties found" />
        )}
      </Panel>
      <PartyFormDialog open={creating} onClose={() => setCreating(false)} />
      {editing && (
        <PartyFormDialog key={editing.id} open party={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

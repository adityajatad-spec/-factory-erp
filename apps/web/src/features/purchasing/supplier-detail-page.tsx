import {
  PERMISSIONS,
  type BankAccountDto,
  type PartyDto,
  type PayablesSummaryDto,
  type PurchaseOrderListItemDto,
  type RestrictedBankAccountDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import {
  Badge,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { Field, Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, dateTime, inr } from '../../lib/format';
import { useCan, useSession } from '../../lib/session';
import { PartyFormDialog } from '../parties/party-form';
import { openBillsQuery } from '../payables/bill-allocation-editor';
import { PoStatusBadge, Stat } from './shared';

export function SupplierDetailPage() {
  const { partyId } = useParams({ from: '/app/purchasing/suppliers/$partyId' });
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const party = useQuery({
    queryKey: ['parties', 'one', partyId],
    queryFn: () => api.get<PartyDto>(`/parties/${partyId}`),
  });
  const payables = useQuery({
    queryKey: ['payables', 'summary'],
    queryFn: () => api.get<PayablesSummaryDto>('/payables/summary'),
    enabled: can(PERMISSIONS.payablesRead),
  });
  const bills = useQuery({ ...openBillsQuery(partyId), enabled: can(PERMISSIONS.payablesRead) });
  const orders = useQuery({
    queryKey: ['purchase-orders', 'supplier', partyId],
    queryFn: () =>
      api.get<PurchaseOrderListItemDto[]>('/purchase-orders', { supplierId: partyId, limit: 10 }),
    enabled: can(PERMISSIONS.purchaseOrderRead),
  });

  if (party.isPending) return <Spinner />;
  if (party.error) return <ErrorBanner error={party.error} />;
  const p = party.data;
  const owed = payables.data?.suppliers.find((s) => s.supplierId === p.id);

  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={`${p.code} · ${p.gstin ?? 'Unregistered'} · ${p.stateName} · ${p.creditDays ?? 0} days credit`}
        actions={
          <>
            <Link to="/purchasing/suppliers">
              <Button>All suppliers</Button>
            </Link>
            {can(PERMISSIONS.partyUpdate) && <Button onClick={() => setEditing(true)}>Edit</Button>}
            {can(PERMISSIONS.purchaseOrderDraft) && (
              <Link to="/purchasing/orders/new">
                <Button>New purchase order</Button>
              </Link>
            )}
            {can(PERMISSIONS.supplierPaymentRequest) && (
              <Link to="/finance/supplier-payments/new" search={{ supplierId: p.id }}>
                <Button variant="primary">Record payment</Button>
              </Link>
            )}
          </>
        }
      />

      {owed && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="We owe" value={inr(owed.balance)} testId="supplier-owed" />
          <Stat
            label="Overdue"
            value={inr(owed.overdueAmount)}
            tone={owed.overdueInvoiceCount ? 'bad' : 'plain'}
          />
          <Stat label="Due this week" value={inr(owed.dueThisWeekAmount)} />
          <Stat label="On account (advance)" value={inr(owed.unallocatedAmount)} />
        </div>
      )}

      <div className="space-y-4">
        <BankDetailsPanel partyId={p.id} />

        {can(PERMISSIONS.payablesRead) && (
          <Panel title="Unpaid bills">
            {bills.data?.length ? (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Bill</th>
                    <th className={th}>Supplier no.</th>
                    <th className={th}>Due</th>
                    <th className={`${th} text-right`}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.data.map((b) => (
                    <tr key={b.purchaseInvoiceId}>
                      <td className={`${td} font-mono text-xs`}>
                        <Link
                          to="/purchasing/bills/$invoiceId"
                          params={{ invoiceId: b.purchaseInvoiceId }}
                          className="hover:underline"
                        >
                          {b.invoiceNumber}
                        </Link>
                      </td>
                      <td className={`${td} font-mono text-xs`}>{b.supplierInvoiceNumber}</td>
                      <td className={td}>
                        {date(b.dueDate)} {b.isOverdue && <Badge tone="red">late</Badge>}
                      </td>
                      <td className={`${tdNum} font-medium`}>{inr(b.outstandingAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-3 text-sm text-slate-500">Nothing unpaid.</p>
            )}
          </Panel>
        )}

        {can(PERMISSIONS.purchaseOrderRead) && (
          <Panel title="Recent purchase orders">
            {orders.data?.length ? (
              <ul className="divide-y divide-slate-100">
                {orders.data.map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <Link
                      to="/purchasing/orders/$orderId"
                      params={{ orderId: o.id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {o.poNumber ?? 'Draft'}
                    </Link>
                    <span className="text-slate-500">{date(o.poDate)}</span>
                    <PoStatusBadge status={o.status} overdue={o.isOverdue} />
                    <span className="font-medium tabular">{inr(o.grandTotal)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-3 text-sm text-slate-500">No orders yet.</p>
            )}
          </Panel>
        )}
      </div>
      {editing && (
        <PartyFormDialog key={p.version} open party={p} onClose={() => setEditing(false)} />
      )}
    </>
  );
}

const EMPTY_BANK = {
  accountHolderName: '',
  accountNumber: '',
  ifsc: '',
  bankName: '',
  branch: '',
  changeReason: '',
};

/**
 * RESTRICTED: shown only to holders of party.bank.read. Full numbers are revealed on request,
 * never stored in the browser beyond this view, and every change needs a second person.
 */
function BankDetailsPanel({ partyId }: { partyId: string }) {
  const can = useCan();
  const session = useSession();
  const queryClient = useQueryClient();
  const [reveal, setReveal] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [form, setForm] = useState(EMPTY_BANK);
  const [rejecting, setRejecting] = useState<BankAccountDto | null>(null);
  const [reason, setReason] = useState('');
  const accounts = useQuery({
    queryKey: ['bank-accounts', partyId],
    queryFn: () => api.get<RestrictedBankAccountDto[]>(`/parties/${partyId}/bank-accounts`),
    enabled: can(PERMISSIONS.partyBankRead),
    gcTime: 0,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['bank-accounts', partyId] });
  const propose = useMutation({
    mutationFn: () =>
      api.post<BankAccountDto>(`/parties/${partyId}/bank-accounts`, {
        ...form,
        bankName: form.bankName || null,
        branch: form.branch || null,
      }),
    onSuccess: async () => {
      setProposing(false);
      setForm(EMPTY_BANK);
      await refresh();
    },
  });
  const decide = useMutation({
    mutationFn: ({ b, kind }: { b: BankAccountDto; kind: 'approve' | 'reject' }) =>
      api.post<BankAccountDto>(`/bank-accounts/${b.id}/${kind}`, {
        expectedVersion: b.version,
        ...(kind === 'reject' ? { reason } : {}),
      }),
    onSuccess: async () => {
      setRejecting(null);
      setReason('');
      await refresh();
    },
  });

  if (!can(PERMISSIONS.partyBankRead)) {
    return (
      <Panel title="Bank details">
        <p className="p-3 text-sm text-slate-500">
          Restricted: you do not have permission to see supplier bank details.
        </p>
      </Panel>
    );
  }
  const list = accounts.data ?? [];
  const current = list.filter((b) => b.status === 'ACTIVE' || b.status === 'PENDING_APPROVAL');
  const history = list.filter((b) => b.status === 'SUPERSEDED' || b.status === 'REJECTED');

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Bank details <Badge tone="red">Restricted</Badge>
        </span>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)}>
            {reveal ? 'Hide numbers' : 'Show full numbers'}
          </Button>
          {can(PERMISSIONS.partyBankRequest) &&
            !list.some((b) => b.status === 'PENDING_APPROVAL') && (
              <Button size="sm" onClick={() => setProposing(true)}>
                Propose change
              </Button>
            )}
        </>
      }
    >
      <ErrorBanner error={accounts.error ?? decide.error} className="m-3" />
      {accounts.isPending ? (
        <Spinner />
      ) : current.length === 0 ? (
        <p className="p-3 text-sm text-slate-500">No bank details on record.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Status</th>
              <th className={th}>Account holder</th>
              <th className={th}>Account no.</th>
              <th className={th}>IFSC</th>
              <th className={`${th} hidden md:table-cell`}>Bank</th>
              <th className={`${th} hidden lg:table-cell`}>Proposed / approved</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {current.map((b) => {
              const mine = b.requestedById === session.id;
              return (
                <tr key={b.id}>
                  <td className={td}>
                    <Badge tone={b.status === 'ACTIVE' ? 'green' : 'amber'}>
                      {b.status === 'ACTIVE' ? 'In use' : 'Awaiting approval'}
                    </Badge>
                  </td>
                  <td className={td}>{b.accountHolderName}</td>
                  <td className={`${td} font-mono text-xs`}>
                    {reveal ? b.accountNumber : b.accountNumberMasked}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{b.ifsc}</td>
                  <td className={`${td} hidden md:table-cell`}>{b.bankName ?? '—'}</td>
                  <td className={`${td} hidden text-xs text-slate-500 lg:table-cell`}>
                    {b.requestedByName} {dateTime(b.requestedAt)}
                    {b.approvedByName ? ` → ${b.approvedByName}` : ''}
                    <span className="block">{b.changeReason}</span>
                  </td>
                  <td className={td}>
                    {b.status === 'PENDING_APPROVAL' && can(PERMISSIONS.partyBankApprove) && (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={mine || decide.isPending}
                          title={
                            mine
                              ? 'You proposed these details; someone else must approve them'
                              : undefined
                          }
                          onClick={() => decide.mutate({ b, kind: 'approve' })}
                        >
                          Approve
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setRejecting(b)}>
                          Reject
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {history.length > 0 && (
        <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
          Earlier versions:{' '}
          {history.map((b) => `${b.accountNumberMasked} (${b.status.toLowerCase()})`).join(' · ')}
        </p>
      )}

      <Dialog
        open={proposing}
        onClose={() => setProposing(false)}
        title="Propose bank details"
        wide
        footer={
          <>
            <Button onClick={() => setProposing(false)}>Cancel</Button>
            <Button variant="primary" disabled={propose.isPending} onClick={() => propose.mutate()}>
              Send for approval
            </Button>
          </>
        }
      >
        <ErrorBanner error={propose.error} className="mb-3" />
        <p className="mb-3 text-sm text-slate-600">
          Take bank details only from the supplier&apos;s own letter — never from a bill or an email
          alone. A different person must approve them before payments can use them.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account holder" htmlFor="bank-holder">
            <Input
              id="bank-holder"
              value={form.accountHolderName}
              onChange={(e) => setForm({ ...form, accountHolderName: e.target.value })}
            />
          </Field>
          <Field label="Account number" htmlFor="bank-number">
            <Input
              id="bank-number"
              inputMode="numeric"
              autoComplete="off"
              value={form.accountNumber}
              onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
            />
          </Field>
          <Field label="IFSC" htmlFor="bank-ifsc">
            <Input
              id="bank-ifsc"
              value={form.ifsc}
              onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Bank" htmlFor="bank-name">
            <Input
              id="bank-name"
              value={form.bankName}
              onChange={(e) => setForm({ ...form, bankName: e.target.value })}
            />
          </Field>
          <Field label="Branch" htmlFor="bank-branch">
            <Input
              id="bank-branch"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
            />
          </Field>
          <Field label="Why (e.g. supplier's letter dated …)" htmlFor="bank-reason">
            <Input
              id="bank-reason"
              value={form.changeReason}
              onChange={(e) => setForm({ ...form, changeReason: e.target.value })}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject proposed bank details?"
        footer={
          <>
            <Button onClick={() => setRejecting(null)}>Back</Button>
            <Button
              variant="danger"
              disabled={decide.isPending || reason.trim().length < 3}
              onClick={() => rejecting && decide.mutate({ b: rejecting, kind: 'reject' })}
            >
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="bank-reject-reason">
          <Input
            id="bank-reject-reason"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Dialog>
    </Panel>
  );
}

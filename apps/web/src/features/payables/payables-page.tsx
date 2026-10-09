import { PERMISSIONS, type OpenPayableDto, type PayablesSummaryDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
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
import { Select } from '../../components/field';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { useCan } from '../../lib/session';
import { Stat } from '../purchasing/shared';

type View = 'all' | 'overdue' | 'week';

/** What we owe suppliers. Every figure comes from the server's ledger and allocations. */
export function PayablesPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('all');
  const summary = useQuery({
    queryKey: ['payables', 'summary'],
    queryFn: () => api.get<PayablesSummaryDto>('/payables/summary'),
  });
  const open = useQuery({
    queryKey: ['payables', 'open', view],
    queryFn: () =>
      api.get<OpenPayableDto[]>('/payables/open-invoices', {
        ...(view === 'overdue' ? { overdue: 'true' } : {}),
        ...(view === 'week' ? { dueWithinDays: 7 } : {}),
      }),
  });

  if (summary.isPending) return <Spinner />;
  if (summary.error) return <ErrorBanner error={summary.error} />;
  const t = summary.data.totals;

  return (
    <>
      <PageHeader
        title="Payables"
        subtitle={`What we owe suppliers, as of ${date(summary.data.asOf)}. Balance = posted bills − approved payments.`}
        actions={
          can(PERMISSIONS.supplierPaymentRequest) && (
            <Link to="/finance/supplier-payments/new">
              <Button variant="primary">Record supplier payment</Button>
            </Link>
          )
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="We owe (balance)" value={inr(t.balance)} />
        <Stat
          label="Overdue"
          value={inr(t.overdueAmount)}
          tone={t.overdueInvoiceCount ? 'bad' : 'plain'}
        />
        <Stat label="Due this week" value={inr(t.dueThisWeekAmount)} tone="warn" />
        <Stat label="Paid to date" value={inr(t.paidAmount)} />
        <Stat
          label="Awaiting approval"
          value={inr(t.pendingApprovalAmount)}
          tone={t.pendingApprovalAmount !== '0.00' ? 'info' : 'plain'}
        />
      </div>

      <div className="space-y-4">
        <Panel title="By supplier">
          {summary.data.suppliers.length === 0 ? (
            <EmptyState title="Nothing owed to suppliers" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Supplier</th>
                  <th className={`${th} text-right`}>Billed</th>
                  <th className={`${th} hidden text-right md:table-cell`}>Paid</th>
                  <th className={`${th} text-right`}>Owed</th>
                  <th className={`${th} hidden text-right lg:table-cell`}>On account</th>
                  <th className={`${th} text-right`}>Overdue</th>
                  <th className={`${th} hidden text-right md:table-cell`}>Due this week</th>
                  <th className={`${th} w-8`} />
                </tr>
              </thead>
              <tbody>
                {summary.data.suppliers.map((s) => (
                  <tr key={s.supplierId} className="hover:bg-slate-50">
                    <td className={td}>
                      <Link
                        to="/purchasing/suppliers/$partyId"
                        params={{ partyId: s.supplierId }}
                        className="font-medium hover:underline"
                      >
                        {s.name}
                      </Link>{' '}
                      <span className="font-mono text-xs text-slate-500">{s.code}</span>
                    </td>
                    <td className={tdNum}>{inr(s.billedAmount)}</td>
                    <td className={`${tdNum} hidden md:table-cell`}>{inr(s.paidAmount)}</td>
                    <td className={`${tdNum} font-semibold`}>{inr(s.balance)}</td>
                    <td className={`${tdNum} hidden lg:table-cell`}>
                      {s.unallocatedAmount === '0.00' ? (
                        '—'
                      ) : (
                        <Badge tone="blue">{inr(s.unallocatedAmount)}</Badge>
                      )}
                    </td>
                    <td className={tdNum}>
                      {s.overdueAmount === '0.00' ? (
                        '—'
                      ) : (
                        <Badge tone="red">{inr(s.overdueAmount)}</Badge>
                      )}
                    </td>
                    <td className={`${tdNum} hidden md:table-cell`}>
                      {s.dueThisWeekAmount === '0.00' ? '—' : inr(s.dueThisWeekAmount)}
                    </td>
                    <td className={td}>
                      {can(PERMISSIONS.supplierPaymentRequest) &&
                        s.outstandingAmount !== '0.00' && (
                          <Link
                            to="/finance/supplier-payments/new"
                            search={{ supplierId: s.supplierId }}
                          >
                            <Button size="sm">Pay</Button>
                          </Link>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel
          title="Unpaid bills"
          actions={
            <Select
              aria-label="Show"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              className="w-44"
            >
              <option value="all">All unpaid</option>
              <option value="overdue">Overdue</option>
              <option value="week">Due in the next 7 days</option>
            </Select>
          }
        >
          <ErrorBanner error={open.error} className="m-3" />
          {open.isPending ? (
            <Spinner />
          ) : open.data?.length ? (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Our no.</th>
                  <th className={th}>Supplier</th>
                  <th className={`${th} hidden md:table-cell`}>Supplier bill</th>
                  <th className={th}>Due</th>
                  <th className={`${th} hidden text-right md:table-cell`}>Total</th>
                  <th className={`${th} text-right`}>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {open.data.map((b) => (
                  <tr
                    key={b.purchaseInvoiceId}
                    tabIndex={0}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() =>
                      void navigate({
                        to: '/purchasing/bills/$invoiceId',
                        params: { invoiceId: b.purchaseInvoiceId },
                      })
                    }
                  >
                    <td className={`${td} font-mono text-xs`}>{b.invoiceNumber}</td>
                    <td className={`${td} max-w-56 truncate`}>{b.supplierName}</td>
                    <td className={`${td} hidden font-mono text-xs md:table-cell`}>
                      {b.supplierInvoiceNumber}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {date(b.dueDate)}{' '}
                      {b.isOverdue && <Badge tone="red">{b.daysOverdue} days late</Badge>}
                    </td>
                    <td className={`${tdNum} hidden md:table-cell`}>{inr(b.grandTotal)}</td>
                    <td className={`${tdNum} font-medium`}>{inr(b.outstandingAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No unpaid bills here" />
          )}
        </Panel>
      </div>
    </>
  );
}

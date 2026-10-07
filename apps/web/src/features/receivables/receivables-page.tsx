import { AGEING_BUCKETS, PERMISSIONS, type ReceivablesSummaryDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
import { IconPlus } from '../../components/icons';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { useCan } from '../../lib/session';

const isZero = (v: string) => /^-?0+(\.0+)?$/.test(v);

export function ReceivablesPage() {
  const can = useCan();
  const summary = useQuery({
    queryKey: ['receivables', 'summary'],
    queryFn: () => api.get<ReceivablesSummaryDto>('/receivables/summary'),
  });

  if (summary.isPending) return <Spinner />;
  if (summary.error) return <ErrorBanner error={summary.error} />;
  const s = summary.data;
  const customers = s.customers.filter(
    (c) => !isZero(c.balance) || !isZero(c.unallocatedAmount) || c.openInvoiceCount > 0,
  );

  return (
    <>
      <PageHeader
        title="Receivables"
        subtitle={`What customers owe, as of ${date(s.asOf)}. Ageing is by invoice date, after payments and credit notes; cancelled invoices are excluded.`}
        actions={
          can(PERMISSIONS.receiptRecord) && (
            <Link to="/finance/receipts/new">
              <Button variant="primary">
                <IconPlus /> Record receipt
              </Button>
            </Link>
          )
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card label="Net receivable" value={s.totals.balance} hint="Invoiced minus received" />
        <Card
          label="Unallocated credits"
          value={s.totals.unallocatedAmount}
          hint="Receipts not yet matched to invoices"
        />
        {AGEING_BUCKETS.map((b) => (
          <Card
            key={b.key}
            label={b.label}
            value={s.totals.ageing[b.key]}
            warn={b.minDays > 60 && !isZero(s.totals.ageing[b.key])}
          />
        ))}
      </div>

      <Panel title={`${customers.length} customers with a balance`}>
        {customers.length === 0 ? (
          <EmptyState title="Nothing outstanding" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Customer</th>
                <th className={`${th} text-right`}>Balance</th>
                <th className={`${th} hidden text-right md:table-cell`}>Unallocated</th>
                {AGEING_BUCKETS.map((b) => (
                  <th key={b.key} className={`${th} hidden text-right lg:table-cell`}>
                    {b.label}
                  </th>
                ))}
                <th className={`${th} text-right`}>Open bills</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.customerId} className="hover:bg-slate-50">
                  <td className={td}>
                    <Link
                      to="/sales/invoices"
                      search={{ customerId: c.customerId, status: 'ISSUED' }}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="ml-2 font-mono text-[11px] text-slate-400">{c.code}</span>
                  </td>
                  <td
                    className={`${tdNum} font-semibold ${c.balance.startsWith('-') ? 'text-sky-700' : ''}`}
                  >
                    {inr(c.balance)}
                    {c.balance.startsWith('-') && (
                      <span className="ml-1 text-[10px] font-normal">credit</span>
                    )}
                  </td>
                  <td className={`${tdNum} hidden md:table-cell`}>
                    {isZero(c.unallocatedAmount) ? '—' : inr(c.unallocatedAmount)}
                  </td>
                  {AGEING_BUCKETS.map((b) => (
                    <td
                      key={b.key}
                      className={`${tdNum} hidden lg:table-cell ${b.minDays > 60 && !isZero(c.ageing[b.key]) ? 'font-medium text-red-700' : ''}`}
                    >
                      {isZero(c.ageing[b.key]) ? '—' : inr(c.ageing[b.key])}
                    </td>
                  ))}
                  <td className={tdNum}>{c.openInvoiceCount}</td>
                  <td className={`${td} text-right`}>
                    {can(PERMISSIONS.receiptRecord) && (
                      <Link
                        to="/finance/receipts/new"
                        search={{ customerId: c.customerId }}
                        className="text-xs font-medium whitespace-nowrap text-slate-600 hover:text-slate-900"
                      >
                        Record receipt →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}

function Card({
  label,
  value,
  hint,
  warn = false,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-3 ${warn ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}
      title={hint}
    >
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular ${warn ? 'text-red-800' : 'text-slate-900'}`}
      >
        {inr(value)}
      </p>
    </div>
  );
}

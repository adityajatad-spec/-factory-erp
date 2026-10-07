import type { OpenInvoiceDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/button';
import { EmptyState, ErrorBanner, Spinner, td, tdNum, th } from '../../components/display';
import { Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { allocateOldestFirst, checkDraftAllocations } from './allocation-math';

export function openInvoicesQuery(customerId: string) {
  return {
    queryKey: ['receivables', 'open-invoices', customerId],
    queryFn: () => api.get<OpenInvoiceDto[]>('/receivables/open-invoices', { customerId }),
  } as const;
}

/**
 * Bill-wise allocation grid: the customer's open invoices (oldest first) with an amount box
 * each. `available` is the money that can still be allocated (receipt amount, or a receipt's
 * unallocated balance). The server re-validates everything.
 */
export function AllocationEditor({
  customerId,
  available,
  amounts,
  onChange,
}: {
  customerId: string;
  available: string;
  amounts: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
}) {
  const open = useQuery(openInvoicesQuery(customerId));
  if (open.isPending) return <Spinner label="Loading open invoices…" />;
  if (open.error) return <ErrorBanner error={open.error} className="m-3" />;
  const invoices = open.data;
  if (invoices.length === 0) {
    return (
      <EmptyState title="No open invoices for this customer">
        The whole amount will stay on the customer&apos;s account as an unallocated credit.
      </EmptyState>
    );
  }

  const check = checkDraftAllocations(available, invoices, amounts);
  const set = (id: string, value: string) => onChange({ ...amounts, [id]: value });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <p className="text-xs text-slate-500">
          Allocate against specific bills. Anything left over stays on account and can be allocated
          later.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onChange(allocateOldestFirst(available, invoices))}>
            Allocate oldest first
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            Clear
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className={th}>Invoice</th>
              <th className={th}>Date</th>
              <th className={`${th} text-right`}>Age</th>
              <th className={`${th} text-right`}>Total</th>
              <th className={`${th} text-right`}>Outstanding</th>
              <th className={`${th} w-40 text-right`}>Allocate (₹)</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const error = check.rowErrors[inv.invoiceId];
              return (
                <tr key={inv.invoiceId} className="align-top">
                  <td className={`${td} font-mono text-xs`}>
                    <Link
                      to="/sales/invoices/$invoiceId"
                      params={{ invoiceId: inv.invoiceId }}
                      className="hover:underline"
                    >
                      {inv.invoiceNumber}
                    </Link>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{date(inv.invoiceDate)}</td>
                  <td className={tdNum}>{inv.ageDays} d</td>
                  <td className={tdNum}>{inr(inv.grandTotal)}</td>
                  <td className={`${tdNum} font-medium`}>{inr(inv.outstandingAmount)}</td>
                  <td className={td}>
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={`Allocate to ${inv.invoiceNumber}`}
                        inputMode="decimal"
                        className={`text-right tabular ${error ? 'border-red-400' : ''}`}
                        placeholder="0.00"
                        value={amounts[inv.invoiceId] ?? ''}
                        onChange={(e) => set(inv.invoiceId, e.target.value)}
                      />
                      <button
                        type="button"
                        title="Allocate the full outstanding amount"
                        className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                        onClick={() => set(inv.invoiceId, inv.outstandingAmount)}
                      >
                        Full
                      </button>
                    </div>
                    {error && <p className="mt-0.5 text-[11px] text-red-700">{error}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t border-slate-100 px-3 py-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-slate-500">Available</dt>
          <dd className="tabular">{inr(available || '0')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">Allocated</dt>
          <dd className="font-medium tabular">{inr(check.total.toString())}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">Left on account</dt>
          <dd className={`font-medium tabular ${check.overAllocated ? 'text-red-700' : ''}`}>
            {check.remaining ? inr(check.remaining.toString()) : '—'}
          </dd>
        </div>
      </dl>
      {check.overAllocated && (
        <p className="px-3 pb-2 text-right text-xs text-red-700">
          Allocations exceed the available amount.
        </p>
      )}
    </div>
  );
}

/** Non-zero allocations, ready for the API. */
export function allocationsPayload(amounts: Readonly<Record<string, string>>) {
  return Object.entries(amounts)
    .map(([invoiceId, amount]) => ({ invoiceId, amount: amount.trim() }))
    .filter((a) => a.amount !== '' && !/^0*(\.0*)?$/.test(a.amount));
}

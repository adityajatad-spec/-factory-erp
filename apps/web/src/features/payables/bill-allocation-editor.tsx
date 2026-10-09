import type { OpenPayableDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorBanner, Spinner, td, tdNum, th } from '../../components/display';
import { Input } from '../../components/field';
import { api } from '../../lib/api';
import { date, inr } from '../../lib/format';
import { allocateOldestFirst, checkDraftAllocations } from '../receivables/allocation-math';

export function openBillsQuery(supplierId: string) {
  return {
    queryKey: ['payables', 'open', 'supplier', supplierId],
    queryFn: () => api.get<OpenPayableDto[]>('/payables/open-invoices', { supplierId }),
  } as const;
}

/** The allocation rules' shape: bill id + what is still owed on it. */
export const asOpenAmounts = (bills: readonly OpenPayableDto[]) =>
  bills.map((b) => ({ invoiceId: b.purchaseInvoiceId, outstandingAmount: b.outstandingAmount }));

/**
 * Bill-wise allocation grid for a supplier payment: unpaid bills by due date with an amount
 * each. Anything left over stays on account (an advance). The server re-checks everything.
 */
export function BillAllocationEditor({
  supplierId,
  available,
  amounts,
  onChange,
}: {
  supplierId: string;
  available: string;
  amounts: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
}) {
  const open = useQuery(openBillsQuery(supplierId));
  if (open.isPending) return <Spinner label="Loading unpaid bills…" />;
  if (open.error) return <ErrorBanner error={open.error} className="m-3" />;
  const bills = open.data;
  if (bills.length === 0) {
    return (
      <EmptyState title="No unpaid bills for this supplier">
        The whole amount will be held on account as an advance.
      </EmptyState>
    );
  }
  const check = checkDraftAllocations(available, asOpenAmounts(bills), amounts);
  const set = (id: string, value: string) => onChange({ ...amounts, [id]: value });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <p className="text-xs text-slate-500">Settle specific bills; the rest stays on account.</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => onChange(allocateOldestFirst(available, asOpenAmounts(bills)))}
          >
            Allocate by due date
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
              <th className={th}>Bill</th>
              <th className={th}>Supplier no.</th>
              <th className={th}>Due</th>
              <th className={`${th} text-right`}>Outstanding</th>
              <th className={`${th} w-40 text-right`}>Pay (₹)</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => {
              const error = check.rowErrors[b.purchaseInvoiceId];
              return (
                <tr key={b.purchaseInvoiceId} className="align-top">
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
                  <td className={`${td} whitespace-nowrap`}>
                    {date(b.dueDate)} {b.isOverdue && <Badge tone="red">late</Badge>}
                  </td>
                  <td className={`${tdNum} font-medium`}>{inr(b.outstandingAmount)}</td>
                  <td className={td}>
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={`Pay ${b.invoiceNumber}`}
                        inputMode="decimal"
                        className={`text-right tabular ${error ? 'border-red-400' : ''}`}
                        placeholder="0.00"
                        value={amounts[b.purchaseInvoiceId] ?? ''}
                        onChange={(e) => set(b.purchaseInvoiceId, e.target.value)}
                      />
                      <button
                        type="button"
                        title="Pay the full outstanding amount"
                        className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                        onClick={() => set(b.purchaseInvoiceId, b.outstandingAmount)}
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
    </div>
  );
}

/** Non-zero allocations, ready for the API. */
export function billAllocationsPayload(amounts: Readonly<Record<string, string>>) {
  return Object.entries(amounts)
    .map(([purchaseInvoiceId, amount]) => ({ purchaseInvoiceId, amount: amount.trim() }))
    .filter((a) => a.amount !== '' && !/^0*(\.0*)?$/.test(a.amount));
}

import type { InvoiceListItemDto, InvoiceStatus } from '@factory-erp/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Badge, Table, td, tdNum, th } from '../../components/display';
import { date, inr } from '../../lib/format';
import { PaymentBadge } from '../receivables/labels';

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  // Cancelled invoices are void, not owed: neutral grey, never the red of "unpaid".
  const tone = status === 'ISSUED' ? 'green' : status === 'DRAFT' ? 'amber' : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

export function InvoiceTable({ invoices }: { invoices: readonly InvoiceListItemDto[] }) {
  const navigate = useNavigate();
  const open = (id: string) =>
    void navigate({ to: '/sales/invoices/$invoiceId', params: { invoiceId: id } });
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Number</th>
          <th className={th}>Date</th>
          <th className={th}>Customer</th>
          <th className={`${th} hidden md:table-cell`}>Supply</th>
          <th className={th}>Status</th>
          <th className={th}>Payment</th>
          <th className={`${th} text-right`}>Grand total</th>
          <th className={`${th} hidden text-right sm:table-cell`}>Outstanding</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => (
          <tr
            key={inv.id}
            tabIndex={0}
            onClick={() => open(inv.id)}
            onKeyDown={(e) => e.key === 'Enter' && open(inv.id)}
            className="cursor-pointer hover:bg-slate-50 focus:bg-accent-50 focus:outline-none"
          >
            <td className={`${td} font-mono text-xs font-medium whitespace-nowrap`}>
              {inv.invoiceNumber ?? <span className="text-slate-400">— draft —</span>}
            </td>
            <td className={`${td} whitespace-nowrap`}>{date(inv.invoiceDate)}</td>
            <td className={`${td} max-w-64 truncate`}>{inv.customerName}</td>
            <td className={`${td} hidden text-xs text-slate-500 md:table-cell`}>
              {inv.supplyType === 'INTER_STATE' ? 'Inter-state · IGST' : 'Intra-state · CGST+SGST'}
            </td>
            <td className={td}>
              <StatusBadge status={inv.status} />
            </td>
            <td className={td}>
              <PaymentBadge status={inv.paymentStatus} />
            </td>
            <td className={`${tdNum} font-medium`}>{inr(inv.grandTotal)}</td>
            <td className={`${tdNum} hidden sm:table-cell`}>
              {inv.outstandingAmount === null ? '—' : inr(inv.outstandingAmount)}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

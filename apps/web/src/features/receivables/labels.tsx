import type { PaymentMode, PaymentStatus } from '@factory-erp/contracts';
import { Badge } from '../../components/display';

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  BANK_TRANSFER: 'Bank transfer',
  UPI: 'UPI',
  CHEQUE: 'Cheque',
  CASH: 'Cash',
  CARD: 'Card',
  OTHER: 'Other',
};

const STATUS: Record<PaymentStatus, { label: string; tone: 'red' | 'amber' | 'green' | 'blue' }> = {
  UNPAID: { label: 'Unpaid', tone: 'red' },
  PARTIALLY_PAID: { label: 'Part-paid', tone: 'amber' },
  PAID: { label: 'Paid', tone: 'green' },
  // Settled by credit notes, not by money received.
  CREDITED: { label: 'Credited', tone: 'blue' },
};

export function PaymentBadge({ status }: { status: PaymentStatus | null }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

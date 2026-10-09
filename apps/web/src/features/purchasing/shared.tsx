import type {
  AuditEventDto,
  ItemDto,
  MatchFinding,
  MatchStatus,
  PartyDto,
  PayableStatus,
  PurchaseOrderStatus,
  SupplierPaymentStatus,
  WarehouseDto,
} from '@factory-erp/contracts';
import { PERMISSIONS } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { Badge, Panel } from '../../components/display';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useCan } from '../../lib/session';

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

const PO_STATUS: Record<PurchaseOrderStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  APPROVED: { label: 'Approved', tone: 'blue' },
  PARTIALLY_RECEIVED: { label: 'Part-received', tone: 'amber' },
  RECEIVED: { label: 'Received', tone: 'green' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'red' },
};

export function PoStatusBadge({
  status,
  overdue,
}: {
  status: PurchaseOrderStatus;
  overdue?: boolean;
}) {
  const s = PO_STATUS[status];
  return (
    <span className="inline-flex gap-1">
      <Badge tone={s.tone}>{s.label}</Badge>
      {overdue && (
        <Badge tone="red" title="Expected delivery date has passed with goods still to come">
          Overdue
        </Badge>
      )}
    </span>
  );
}

const MATCH: Record<MatchStatus, { label: string; tone: Tone; title: string }> = {
  MATCHED: { label: 'Matched', tone: 'green', title: 'Agrees with the PO and the goods received' },
  NOT_APPLICABLE: {
    label: 'Direct',
    tone: 'neutral',
    title: 'No purchase order: only the total is checked',
  },
  ACCEPTED_WITH_DIFFERENCES: {
    label: 'Accepted with differences',
    tone: 'amber',
    title: 'Posted despite three-way-match differences, with a reason',
  },
};

export function MatchBadge({ status }: { status: MatchStatus | null }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  const m = MATCH[status];
  return (
    <Badge tone={m.tone} title={m.title}>
      {m.label}
    </Badge>
  );
}

const PAYABLE: Record<PayableStatus, { label: string; tone: Tone }> = {
  UNPAID: { label: 'Unpaid', tone: 'red' },
  PARTIALLY_PAID: { label: 'Part-paid', tone: 'amber' },
  PAID: { label: 'Paid', tone: 'green' },
};

export function PayableBadge({
  status,
  overdue,
}: {
  status: PayableStatus | null;
  overdue?: boolean;
}) {
  if (!status) return <Badge>Draft</Badge>;
  const s = PAYABLE[status];
  return (
    <span className="inline-flex gap-1">
      <Badge tone={s.tone}>{s.label}</Badge>
      {overdue && <Badge tone="red">Overdue</Badge>}
    </span>
  );
}

const PAYMENT: Record<SupplierPaymentStatus, { label: string; tone: Tone }> = {
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  REJECTED: { label: 'Rejected', tone: 'red' },
};

export function PaymentStatusBadge({ status }: { status: SupplierPaymentStatus }) {
  const s = PAYMENT[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const FINDING_LABELS: Record<MatchFinding['code'], string> = {
  NOT_ON_ORDER: 'Not on the order',
  ITEM_MISMATCH: 'Different item',
  QTY_EXCEEDS_RECEIVED: 'More than received',
  PRICE_ABOVE_ORDER: 'Price above order',
  TOTAL_MISMATCH: 'Total differs',
};

/** Masters for purchasing screens (lists are capped and filtered client-side, as on sales). */
export function useSuppliers() {
  return useQuery({
    queryKey: ['parties', 'suppliers-all'],
    queryFn: () => api.get<PartyDto[]>('/parties', { role: 'supplier', limit: 200 }),
  });
}
export function usePurchasableItems() {
  return useQuery({
    queryKey: ['items', 'all-active'],
    queryFn: () => api.get<ItemDto[]>('/items', { limit: 200 }),
  });
}
export function useWarehouses() {
  return useQuery({
    queryKey: ['warehouses'],
    queryFn: () => api.get<WarehouseDto[]>('/inventory/warehouses'),
    staleTime: 5 * 60_000,
  });
}

/** The audit trail of one record, for users allowed to read it. */
export function HistoryPanel({
  entityType,
  entityId,
  refreshKey,
}: {
  entityType: string;
  entityId: string;
  refreshKey?: unknown;
}) {
  const can = useCan();
  const history = useQuery({
    queryKey: ['audit', entityType, entityId, refreshKey],
    queryFn: () => api.get<AuditEventDto[]>('/audit-events', { entityType, entityId }),
    enabled: can(PERMISSIONS.auditRead),
  });
  if (!can(PERMISSIONS.auditRead)) return null;
  return (
    <Panel title="History (audit trail)">
      <ol className="divide-y divide-slate-100">
        {(history.data ?? []).map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm">
            <span>{e.summary}</span>
            <span className="text-xs text-slate-500">
              {e.actorName ?? e.actorKind} · {dateTime(e.occurredAt)}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function Stat({
  label,
  value,
  tone = 'plain',
  testId,
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'info' | 'warn' | 'bad';
  testId?: string;
}) {
  const TONE = {
    plain: 'border-slate-200 bg-white',
    info: 'border-sky-200 bg-sky-50',
    warn: 'border-amber-200 bg-amber-50',
    bad: 'border-red-200 bg-red-50',
  } as const;
  return (
    <div className={`rounded-lg border px-3 py-3 ${TONE[tone]}`} data-testid={testId}>
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900 tabular">{value}</p>
    </div>
  );
}

/** Invalidate everything a purchasing or payables change can affect. */
export const PURCHASING_KEYS = [
  'purchase-orders',
  'purchase-order',
  'goods-receipts',
  'goods-receipt',
  'bills',
  'bill',
  'payables',
  'supplier-payments',
  'supplier-payment',
  'stock',
  'movements',
  'items',
  'dashboard',
  'audit',
] as const;

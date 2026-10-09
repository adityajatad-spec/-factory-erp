import { ListAuditEventsQuery, PERMISSIONS, type AuditEventDto } from '@factory-erp/contracts';
import { formatINR, isDecimalString, Money } from '@factory-erp/money';
import { defineQuery } from '../../platform/queries';

const ACTOR_KINDS = ['user', 'ai_agent', 'system', 'integration'] as const;

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const rupees = (v: unknown): string =>
  typeof v === 'string' && isDecimalString(v) ? formatINR(Money.of(v)) : '—';

function summarise(command: string, entityType: string, after: unknown): string {
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  if (
    entityType === 'sales.invoice' &&
    (command === 'finance.receipt.record' || command === 'finance.receipt.allocate')
  ) {
    return `Payment ${rupees(a.allocatedAmount)} applied from ${str(a.receiptNumber)} (outstanding now ${rupees(a.outstandingAmount)})`;
  }
  if (entityType === 'sales.invoice' && command === 'sales.creditNote.issue') {
    return `Credit note ${str(a.creditNoteNumber)} for ${rupees(a.creditedAmount)} issued (outstanding now ${rupees(a.outstandingAmount)})`;
  }
  if (
    entityType === 'purchase.invoice' &&
    (command === 'finance.supplierPayment.approve' ||
      command === 'finance.supplierPayment.allocate')
  ) {
    return `Payment ${rupees(a.allocatedAmount)} applied from ${str(a.paymentNumber)} (outstanding now ${rupees(a.outstandingAmount)})`;
  }
  if (entityType === 'purchase.order' && command === 'purchase.grn.record') {
    return `Goods received — order is now ${str(a.status)}`;
  }
  switch (command) {
    case 'purchase.order.createDraft':
      return `Purchase order draft created (total ${rupees(a.grandTotal)})`;
    case 'purchase.order.updateDraft':
      return `Purchase order draft updated (total ${rupees(a.grandTotal)})`;
    case 'purchase.order.approve':
      return `Approved as ${str(a.poNumber)} (total ${rupees(a.grandTotal)})`;
    case 'purchase.order.cancel':
      return `Cancelled — ${str(a.reason)}`;
    case 'purchase.order.close':
      return `Short-closed — ${str(a.reason)}`;
    case 'documents.purchaseOrderPdf.generate':
      return 'Purchase order PDF generated';
    case 'purchase.grn.record':
      return `Goods receipt ${str(a.grnNumber)} recorded`;
    case 'purchase.invoice.createDraft':
      return `Supplier bill ${str(a.supplierInvoiceNumber)} entered as a draft (total ${rupees(a.grandTotal)})`;
    case 'purchase.invoice.updateDraft':
      return `Supplier bill draft updated (total ${rupees(a.grandTotal)})`;
    case 'purchase.invoice.post':
      return `Posted as ${str(a.invoiceNumber)} (total ${rupees(a.grandTotal)}; match ${str(a.matchStatus)})${
        str(a.matchOverrideReason) ? ` — accepted: ${str(a.matchOverrideReason)}` : ''
      }`;
    case 'finance.supplierPayment.request':
      return `Supplier payment of ${rupees(a.amount)} recorded, awaiting approval`;
    case 'finance.supplierPayment.approve':
      return `Approved as ${str(a.paymentNumber)} (${rupees(a.amount)}; on account ${rupees(a.unallocatedAmount)})`;
    case 'finance.supplierPayment.reject':
      return `Rejected — ${str(a.reason)}`;
    case 'finance.supplierPayment.allocate':
      return `Allocated to bills (on account now ${rupees(a.unallocatedAmount)})`;
    case 'parties.bankAccount.propose':
      return `Bank details proposed (${str(a.ifsc)}, account ${str(a.accountNumberMasked)}), awaiting approval`;
    case 'parties.bankAccount.approve':
      return a.status === 'SUPERSEDED'
        ? 'Bank details superseded by newly approved ones'
        : `Bank details approved (${str(a.ifsc)}, account ${str(a.accountNumberMasked)})`;
    case 'parties.bankAccount.reject':
      return `Bank details rejected — ${str(a.reason)}`;
    case 'sales.invoice.cancel':
      return `Cancelled — ${str(a.reason)} (${rupees(a.reversedAmount)} reversed from the customer balance)`;
    case 'sales.creditNote.createDraft':
      return `Credit note draft created against ${str(a.invoiceNumber)} (total ${rupees(a.grandTotal)})`;
    case 'sales.creditNote.updateDraft':
      return `Credit note draft updated (total ${rupees(a.grandTotal)})`;
    case 'sales.creditNote.issue':
      return `Issued as ${str(a.creditNoteNumber)} against ${str(a.invoiceNumber)} (total ${rupees(a.grandTotal)})`;
    case 'documents.salesCreditNotePdf.generate':
      return 'Credit note PDF generated';
    case 'finance.receipt.record':
      return `Receipt ${str(a.receiptNumber)} recorded for ${rupees(a.amount)} (unallocated ${rupees(a.unallocatedAmount)})`;
    case 'finance.receipt.allocate':
      return `Allocated to invoices (unallocated now ${rupees(a.unallocatedAmount)})`;
    case 'sales.invoice.createDraft':
      return `Draft created (total ${rupees(a.grandTotal)})`;
    case 'sales.invoice.updateDraft':
      return `Draft updated (total ${rupees(a.grandTotal)})`;
    case 'sales.invoice.issue':
      return `Issued as ${str(a.invoiceNumber)} (total ${rupees(a.grandTotal)})`;
    case 'documents.salesInvoicePdf.generate':
      return 'Invoice PDF generated';
    default:
      return command;
  }
}

export const listAuditEvents = defineQuery({
  name: 'audit.events.list',
  description: 'History of changes to one record.',
  input: ListAuditEventsQuery,
  permission: PERMISSIONS.auditRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: async ({ db, companyId }, input): Promise<AuditEventDto[]> => {
    const rows = await db
      .selectFrom('audit.events as e')
      .leftJoin('identity.users as u', 'u.id', 'e.actorUserId')
      .select([
        'e.id',
        'e.occurredAt',
        'e.actorKind',
        'u.displayName',
        'e.command',
        'e.entityType',
        'e.entityId',
        'e.after',
      ])
      .where('e.companyId', '=', companyId)
      .where('e.entityType', '=', input.entityType)
      .where('e.entityId', '=', input.entityId)
      .orderBy('e.occurredAt')
      .orderBy('e.id')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actorKind: ACTOR_KINDS.find((k) => k === r.actorKind) ?? 'system',
      actorName: r.displayName,
      command: r.command,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: summarise(r.command, r.entityType, r.after),
    }));
  },
});

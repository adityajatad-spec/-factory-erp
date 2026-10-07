/**
 * Permission codes — the single source of truth, shared by the API (enforcement) and the web
 * app (hiding actions the user cannot perform). Roles are bundles of these codes and live in
 * the database; the server never trusts the client's view of permissions.
 */
export const PERMISSIONS = {
  companyRead: 'company.read',
  partyRead: 'party.read',
  partyCreate: 'party.create',
  itemRead: 'item.read',
  itemCreate: 'item.create',
  salesInvoiceRead: 'sales.invoice.read',
  salesInvoiceDraft: 'sales.invoice.draft',
  salesInvoiceIssue: 'sales.invoice.issue',
  salesInvoiceCancel: 'sales.invoice.cancel',
  creditNoteDraft: 'sales.credit_note.draft',
  creditNoteIssue: 'sales.credit_note.issue',
  inventoryStockRead: 'inventory.stock.read',
  receivablesRead: 'finance.receivables.read',
  receiptRecord: 'finance.receipt.record',
  documentRead: 'document.read',
  auditRead: 'audit.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export const ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'ACCOUNTANT',
  'PRODUCTION_MANAGER',
  'PURCHASE_MANAGER',
  'HR',
  'SUPERVISOR',
  'WORKER',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

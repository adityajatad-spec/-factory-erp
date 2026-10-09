/**
 * Permission codes — the single source of truth, shared by the API (enforcement) and the web
 * app (hiding actions the user cannot perform). Roles are bundles of these codes and live in
 * the database; the server never trusts the client's view of permissions.
 */
export const PERMISSIONS = {
  companyRead: 'company.read',
  partyRead: 'party.read',
  partyCreate: 'party.create',
  partyUpdate: 'party.update',
  itemRead: 'item.read',
  itemCreate: 'item.create',
  itemUpdate: 'item.update',
  salesInvoiceRead: 'sales.invoice.read',
  salesInvoiceDraft: 'sales.invoice.draft',
  salesInvoiceIssue: 'sales.invoice.issue',
  salesInvoiceCancel: 'sales.invoice.cancel',
  creditNoteDraft: 'sales.credit_note.draft',
  creditNoteIssue: 'sales.credit_note.issue',
  inventoryStockRead: 'inventory.stock.read',
  /** Record compensating stock adjustments (counts, damage, mis-postings). */
  inventoryStockAdjust: 'inventory.stock.adjust',
  inventoryWarehouseManage: 'inventory.warehouse.manage',
  receivablesRead: 'finance.receivables.read',
  receiptRecord: 'finance.receipt.record',
  auditRead: 'audit.read',
  purchaseOrderRead: 'purchase.order.read',
  purchaseOrderDraft: 'purchase.order.draft',
  /** Approve a draft order (it is numbered and frozen). Separate from drafting on purpose. */
  purchaseOrderApprove: 'purchase.order.approve',
  /** Cancel an order with nothing received, or short-close a partly received one. */
  purchaseOrderCancel: 'purchase.order.cancel',
  /** Record goods received against an approved order (puts accepted goods into stock). */
  goodsReceiptRecord: 'purchase.grn.record',
  purchaseInvoiceRead: 'purchase.invoice.read',
  /** Enter and edit supplier bills as drafts. */
  purchaseInvoiceDraft: 'purchase.invoice.draft',
  /** Post a bill that passes the three-way match: it becomes owed to the supplier. */
  purchaseInvoicePost: 'purchase.invoice.post',
  /** Post a bill despite three-way-match differences (with a reason). */
  purchaseInvoiceOverrideMatch: 'purchase.invoice.override_match',
  payablesRead: 'finance.payables.read',
  /** Ask for a supplier payment (the maker); allocate approved payments to bills. */
  supplierPaymentRequest: 'finance.supplier_payment.request',
  /** Approve or reject someone else's payment request (the checker). */
  supplierPaymentApprove: 'finance.supplier_payment.approve',
  /** See suppliers' full bank account numbers (RESTRICTED). */
  partyBankRead: 'party.bank.read',
  /** Propose new or changed bank details for a supplier (the maker). */
  partyBankRequest: 'party.bank.request',
  /** Approve or reject someone else's bank-detail change (the checker). */
  partyBankApprove: 'party.bank.approve',
  /**
   * Change the company's AI policy (enable AI, approve local models, set the data ceiling).
   * OWNER only: withheld from ADMIN, and the command also checks the OWNER role itself.
   */
  aiPolicyManage: 'ai.policy.manage',
  /** Every signed-in user: their own account (change password). */
  accountSelf: 'account.self',
  /** Create users, assign roles, deactivate, reset passwords. */
  userManage: 'identity.user.manage',
  /** See failed background jobs (PDFs …) and retry them. */
  outboxManage: 'system.outbox.manage',
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

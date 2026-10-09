import {
  ALL_PERMISSIONS,
  PERMISSIONS as P,
  type Permission,
  type RoleCode,
} from '@factory-erp/contracts';

interface RoleDefinition {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/**
 * Seeded default roles (tenant-editable later). Keep these conservative: a permission
 * missing here is safe; an extra one is a leak.
 */
export const DEFAULT_ROLES: Record<RoleCode, RoleDefinition> = {
  OWNER: {
    name: 'Owner',
    description: 'Full access to all data and actions.',
    permissions: ALL_PERMISSIONS,
  },
  ADMIN: {
    name: 'Administrator',
    description: 'Runs the system day to day. Full access in the current modules.',
    permissions: ALL_PERMISSIONS,
  },
  ACCOUNTANT: {
    name: 'Accountant',
    description:
      'Sales invoicing and corrections, customer receipts and receivables; posts supplier bills that match and requests supplier payments (approval is separate); audit history.',
    permissions: [
      P.companyRead,
      P.accountSelf,
      P.partyRead,
      P.partyCreate,
      P.partyUpdate,
      P.itemRead,
      P.salesInvoiceRead,
      P.salesInvoiceDraft,
      P.salesInvoiceIssue,
      P.salesInvoiceCancel,
      P.creditNoteDraft,
      P.creditNoteIssue,
      P.receivablesRead,
      P.receiptRecord,
      P.auditRead,
      P.inventoryStockRead,
      P.purchaseOrderRead,
      P.purchaseInvoiceRead,
      P.purchaseInvoiceDraft,
      P.purchaseInvoicePost,
      P.payablesRead,
      P.supplierPaymentRequest,
      P.partyBankRead,
      P.partyBankRequest,
    ],
  },
  PRODUCTION_MANAGER: {
    name: 'Production Manager',
    description: 'Items and stock; stock corrections; sees what is on order.',
    permissions: [
      P.companyRead,
      P.accountSelf,
      P.itemRead,
      P.inventoryStockRead,
      P.inventoryStockAdjust,
      P.purchaseOrderRead,
    ],
  },
  PURCHASE_MANAGER: {
    name: 'Purchase Manager',
    description:
      'Suppliers, items and stock; drafts purchase orders (approval is separate), records goods received and enters supplier bills as drafts.',
    permissions: [
      P.companyRead,
      P.accountSelf,
      P.partyRead,
      P.partyCreate,
      P.partyUpdate,
      P.itemRead,
      P.itemCreate,
      P.itemUpdate,
      P.inventoryStockRead,
      P.purchaseOrderRead,
      P.purchaseOrderDraft,
      P.goodsReceiptRecord,
      P.purchaseInvoiceRead,
      P.purchaseInvoiceDraft,
    ],
  },
  HR: {
    name: 'HR',
    description: 'Workforce administration (no HR module yet).',
    permissions: [P.companyRead, P.accountSelf],
  },
  SUPERVISOR: {
    name: 'Supervisor',
    description: 'Shop-floor supervision: items and stock; receives goods against orders.',
    permissions: [
      P.companyRead,
      P.accountSelf,
      P.itemRead,
      P.inventoryStockRead,
      P.purchaseOrderRead,
      P.goodsReceiptRecord,
    ],
  },
  WORKER: {
    name: 'Worker',
    description: 'Shop-floor worker (no worker workflows yet).',
    permissions: [P.companyRead, P.accountSelf],
  },
};

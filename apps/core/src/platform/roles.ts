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
      'Sales invoicing and corrections (cancellation, credit notes), customer receipts, receivables and audit history.',
    permissions: [
      P.companyRead,
      P.partyRead,
      P.partyCreate,
      P.itemRead,
      P.salesInvoiceRead,
      P.salesInvoiceDraft,
      P.salesInvoiceIssue,
      P.salesInvoiceCancel,
      P.creditNoteDraft,
      P.creditNoteIssue,
      P.receivablesRead,
      P.receiptRecord,
      P.documentRead,
      P.auditRead,
      P.inventoryStockRead,
    ],
  },
  PRODUCTION_MANAGER: {
    name: 'Production Manager',
    description: 'Items and stock visibility.',
    permissions: [P.companyRead, P.itemRead, P.inventoryStockRead],
  },
  PURCHASE_MANAGER: {
    name: 'Purchase Manager',
    description: 'Suppliers, items and stock.',
    permissions: [
      P.companyRead,
      P.partyRead,
      P.partyCreate,
      P.itemRead,
      P.itemCreate,
      P.inventoryStockRead,
    ],
  },
  HR: {
    name: 'HR',
    description: 'Workforce administration (no HR module yet).',
    permissions: [P.companyRead],
  },
  SUPERVISOR: {
    name: 'Supervisor',
    description: 'Shop-floor supervision: items and stock visibility.',
    permissions: [P.companyRead, P.itemRead, P.inventoryStockRead],
  },
  WORKER: {
    name: 'Worker',
    description: 'Shop-floor worker (no worker workflows yet).',
    permissions: [P.companyRead],
  },
};

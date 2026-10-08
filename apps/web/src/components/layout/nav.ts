import { PERMISSIONS, type Permission } from '@factory-erp/contracts';
import type { ComponentType } from 'react';
import {
  IconBox,
  IconChart,
  IconCreditNote,
  IconDashboard,
  IconInvoice,
  IconKey,
  IconUsers,
  IconWallet,
} from '../icons';

export interface NavItem {
  to:
    | '/'
    | '/sales/invoices'
    | '/sales/credit-notes'
    | '/sales/customers'
    | '/finance/receipts'
    | '/finance/receivables'
    | '/inventory/items'
    | '/admin/users'
    | '/admin/jobs';
  label: string;
  icon: ComponentType;
  permission: Permission;
}

/**
 * Only modules that actually work are listed. Purchasing, production, workforce and the rest
 * appear here when they are built — no empty placeholder pages.
 */
export const NAV: ReadonlyArray<{ section: string | null; items: readonly NavItem[] }> = [
  {
    section: null,
    items: [
      { to: '/', label: 'Dashboard', icon: IconDashboard, permission: PERMISSIONS.companyRead },
    ],
  },
  {
    section: 'Sales',
    items: [
      {
        to: '/sales/invoices',
        label: 'Invoices',
        icon: IconInvoice,
        permission: PERMISSIONS.salesInvoiceRead,
      },
      {
        to: '/sales/credit-notes',
        label: 'Credit notes',
        icon: IconCreditNote,
        permission: PERMISSIONS.salesInvoiceRead,
      },
      {
        to: '/sales/customers',
        label: 'Customers',
        icon: IconUsers,
        permission: PERMISSIONS.partyRead,
      },
    ],
  },
  {
    section: 'Finance',
    items: [
      {
        to: '/finance/receipts',
        label: 'Receipts',
        icon: IconWallet,
        permission: PERMISSIONS.receivablesRead,
      },
      {
        to: '/finance/receivables',
        label: 'Receivables',
        icon: IconChart,
        permission: PERMISSIONS.receivablesRead,
      },
    ],
  },
  {
    section: 'Inventory',
    items: [
      {
        to: '/inventory/items',
        label: 'Items & stock',
        icon: IconBox,
        permission: PERMISSIONS.itemRead,
      },
    ],
  },
  {
    section: 'Administration',
    items: [
      {
        to: '/admin/users',
        label: 'Users & roles',
        icon: IconKey,
        permission: PERMISSIONS.userManage,
      },
      {
        to: '/admin/jobs',
        label: 'Background jobs',
        icon: IconChart,
        permission: PERMISSIONS.outboxManage,
      },
    ],
  },
];

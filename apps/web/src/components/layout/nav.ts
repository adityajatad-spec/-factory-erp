import { PERMISSIONS, type Permission } from '@factory-erp/contracts';
import type { ComponentType } from 'react';
import {
  IconBank,
  IconBill,
  IconBox,
  IconCart,
  IconChart,
  IconCreditNote,
  IconDashboard,
  IconInvoice,
  IconKey,
  IconLayers,
  IconTruck,
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
    | '/finance/payables'
    | '/finance/supplier-payments'
    | '/purchasing/suppliers'
    | '/purchasing/orders'
    | '/purchasing/receipts'
    | '/purchasing/bills'
    | '/inventory/items'
    | '/inventory/stock'
    | '/admin/users'
    | '/admin/jobs';
  label: string;
  icon: ComponentType;
  permission: Permission;
}

/**
 * Only modules that actually work are listed. Production, workforce and the rest appear here
 * when they are built — no empty placeholder pages.
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
    section: 'Purchasing',
    items: [
      {
        to: '/purchasing/suppliers',
        label: 'Suppliers',
        icon: IconUsers,
        permission: PERMISSIONS.partyRead,
      },
      {
        to: '/purchasing/orders',
        label: 'Purchase orders',
        icon: IconCart,
        permission: PERMISSIONS.purchaseOrderRead,
      },
      {
        to: '/purchasing/receipts',
        label: 'Goods receipts',
        icon: IconTruck,
        permission: PERMISSIONS.purchaseOrderRead,
      },
      {
        to: '/purchasing/bills',
        label: 'Supplier bills',
        icon: IconBill,
        permission: PERMISSIONS.purchaseInvoiceRead,
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
      {
        to: '/finance/payables',
        label: 'Payables',
        icon: IconChart,
        permission: PERMISSIONS.payablesRead,
      },
      {
        to: '/finance/supplier-payments',
        label: 'Supplier payments',
        icon: IconBank,
        permission: PERMISSIONS.payablesRead,
      },
    ],
  },
  {
    section: 'Inventory',
    items: [
      {
        to: '/inventory/items',
        label: 'Items',
        icon: IconBox,
        permission: PERMISSIONS.itemRead,
      },
      {
        to: '/inventory/stock',
        label: 'Stock',
        icon: IconLayers,
        permission: PERMISSIONS.inventoryStockRead,
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

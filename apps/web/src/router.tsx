import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/layout/app-shell';
import { Spinner } from './components/display';
import { ChangePasswordPage } from './features/account/change-password-page';
import { BackgroundJobsPage } from './features/admin/background-jobs-page';
import { UsersPage } from './features/admin/users-page';
import { LoginPage } from './features/auth/login-page';
import { CreditNoteDetailPage } from './features/credit-notes/credit-note-detail-page';
import { CreditNoteEditorPage } from './features/credit-notes/credit-note-editor-page';
import { CreditNotesPage } from './features/credit-notes/credit-notes-page';
import { DashboardPage } from './features/dashboard/dashboard-page';
import { InvoiceDetailPage } from './features/invoices/invoice-detail-page';
import { InvoiceEditorPage } from './features/invoices/invoice-editor-page';
import { InvoicesPage } from './features/invoices/invoices-page';
import { ItemsPage } from './features/items/items-page';
import { CustomersPage } from './features/parties/customers-page';
import { ReceiptDetailPage } from './features/receivables/receipt-detail-page';
import { ReceiptsPage } from './features/receivables/receipts-page';
import { ReceivablesPage } from './features/receivables/receivables-page';
import { RecordReceiptPage } from './features/receivables/record-receipt-page';
import { ApiError } from './lib/api';
import { sessionQuery } from './lib/session';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const searchQ = (s: Record<string, unknown>): { q?: string } =>
  typeof s.q === 'string' && s.q ? { q: s.q } : {};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { next?: string } =>
    typeof s.next === 'string' && s.next.startsWith('/') ? { next: s.next } : {},
  component: LoginPage,
});

/** Authenticated layout: resolves the session first; signed-out users go to /login. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(sessionQuery);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router control flow
        throw redirect({
          to: '/login',
          search: location.pathname === '/' ? {} : { next: location.href },
        });
      }
      throw err;
    }
  },
  pendingComponent: () => <Spinner />,
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
});

const invoicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/invoices',
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    status?: 'DRAFT' | 'ISSUED' | 'CANCELLED';
    payment?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CREDITED';
    customerId?: string;
    q?: string;
  } => ({
    ...searchQ(s),
    ...(s.status === 'DRAFT' || s.status === 'ISSUED' || s.status === 'CANCELLED'
      ? { status: s.status }
      : {}),
    ...(s.payment === 'UNPAID' ||
    s.payment === 'PARTIALLY_PAID' ||
    s.payment === 'PAID' ||
    s.payment === 'CREDITED'
      ? { payment: s.payment }
      : {}),
    ...(typeof s.customerId === 'string' && UUID.test(s.customerId)
      ? { customerId: s.customerId }
      : {}),
  }),
  component: InvoicesPage,
});

export const invoiceNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/invoices/new',
  component: InvoiceEditorPage,
});
export const invoiceDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/invoices/$invoiceId',
  component: InvoiceDetailPage,
});
export const invoiceEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/invoices/$invoiceId/edit',
  component: InvoiceEditorPage,
});

const creditNotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/credit-notes',
  validateSearch: (s: Record<string, unknown>): { status?: 'DRAFT' | 'ISSUED'; q?: string } => ({
    ...searchQ(s),
    ...(s.status === 'DRAFT' || s.status === 'ISSUED' ? { status: s.status } : {}),
  }),
  component: CreditNotesPage,
});
const creditNoteNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/credit-notes/new',
  validateSearch: (s: Record<string, unknown>): { invoiceId?: string } =>
    typeof s.invoiceId === 'string' && UUID.test(s.invoiceId) ? { invoiceId: s.invoiceId } : {},
  component: CreditNoteEditorPage,
});
const creditNoteDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/credit-notes/$creditNoteId',
  component: CreditNoteDetailPage,
});
const creditNoteEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/credit-notes/$creditNoteId/edit',
  component: CreditNoteEditorPage,
});

const customersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales/customers',
  validateSearch: searchQ,
  component: CustomersPage,
});
const itemsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/inventory/items',
  validateSearch: searchQ,
  component: ItemsPage,
});

const receiptsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/finance/receipts',
  component: ReceiptsPage,
});
const receiptNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/finance/receipts/new',
  validateSearch: (s: Record<string, unknown>): { customerId?: string; invoiceId?: string } => ({
    ...(typeof s.customerId === 'string' && UUID.test(s.customerId)
      ? { customerId: s.customerId }
      : {}),
    ...(typeof s.invoiceId === 'string' && UUID.test(s.invoiceId)
      ? { invoiceId: s.invoiceId }
      : {}),
  }),
  component: RecordReceiptPage,
});
const receiptDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/finance/receipts/$receiptId',
  component: ReceiptDetailPage,
});
const receivablesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/finance/receivables',
  component: ReceivablesPage,
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/users',
  component: UsersPage,
});
const jobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/jobs',
  component: BackgroundJobsPage,
});
const passwordRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account/password',
  component: () => <ChangePasswordPage />,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    dashboardRoute,
    invoicesRoute,
    invoiceNewRoute,
    invoiceDetailRoute,
    invoiceEditRoute,
    creditNotesRoute,
    creditNoteNewRoute,
    creditNoteDetailRoute,
    creditNoteEditRoute,
    customersRoute,
    itemsRoute,
    receiptsRoute,
    receiptNewRoute,
    receiptDetailRoute,
    receivablesRoute,
    usersRoute,
    jobsRoute,
    passwordRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

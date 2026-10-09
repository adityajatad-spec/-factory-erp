import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listAuditEvents } from '../modules/audit';
import { getDashboard } from '../modules/analytics';
import {
  archiveItem,
  createItem,
  getItem,
  listHsnCodes,
  listItems,
  listUoms,
  reactivateItem,
  updateItem,
} from '../modules/catalog';
import { getCompany, listStates } from '../modules/company';
import { getDocumentContentQuery } from '../modules/documents';
import { listOutboxEvents, retryOutboxEvent } from '../modules/operations';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseInvoiceDraft,
  createPurchaseOrderDraft,
  deletePurchaseInvoiceDraft,
  deletePurchaseOrderDraft,
  getGoodsReceipt,
  getPurchaseInvoice,
  getPurchaseOrder,
  listGoodsReceipts,
  listPurchaseInvoices,
  listPurchaseOrders,
  matchPurchaseInvoice,
  postPurchaseInvoice,
  recordGoodsReceipt,
  updatePurchaseInvoiceDraft,
  updatePurchaseOrderDraft,
} from '../modules/purchasing';

import {
  adjustStock,
  createWarehouse,
  listStock,
  listStockMovements,
  listWarehouses,
} from '../modules/inventory';
import {
  changeOwnPassword,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetUserPassword,
  setUserRoles,
} from '../modules/identity';
import {
  approveBankAccount,
  archiveParty,
  createParty,
  getParty,
  listBankAccounts,
  listParties,
  proposeBankAccount,
  reactivateParty,
  rejectBankAccount,
  updateParty,
} from '../modules/parties';
import {
  allocateSupplierPayment,
  approveSupplierPayment,
  getPayablesSummary,
  getSupplierPayment,
  listOpenPayables,
  listSupplierPayments,
  rejectSupplierPayment,
  requestSupplierPayment,
} from '../modules/payables';
import {
  allocateReceipt,
  getReceipt,
  getReceivablesSummary,
  listOpenInvoices,
  listReceipts,
  recordReceipt,
} from '../modules/receivables';
import {
  cancelInvoice,
  createCreditNoteDraft,
  createInvoiceDraft,
  deleteCreditNoteDraft,
  deleteInvoiceDraft,
  getCreditNote,
  getInvoice,
  issueCreditNote,
  issueInvoice,
  listCreditNotes,
  listInvoices,
  updateCreditNoteDraft,
  updateInvoiceDraft,
} from '../modules/sales';
import type { BlobStore } from '../platform/blob-store';
import type { CommandBus } from '../platform/commands';
import type { QueryBus } from '../platform/queries';
import { body, commandRoute, params, queryRoute, queryString } from './route-kit';

/**
 * Business routes under /api/v1. Each route only maps HTTP → command/query input; validation,
 * authorization, transactions and audit all happen in the buses.
 */
export function registerBusinessRoutes(
  app: FastifyInstance,
  deps: { commands: CommandBus; queries: QueryBus; blobStore: BlobStore },
): void {
  const { commands: c, queries: q } = deps;

  // Company & reference data
  app.get('/company', queryRoute(q, getCompany));
  app.get('/reference/states', queryRoute(q, listStates));
  app.get('/reference/hsn-codes', queryRoute(q, listHsnCodes));
  app.get('/reference/uoms', queryRoute(q, listUoms));

  // Parties
  app.get('/parties', queryRoute(q, listParties, queryString));
  app.get('/parties/:partyId', queryRoute(q, getParty, params));
  app.post('/parties', commandRoute(c, createParty, body, 201));
  const partyId = (req: FastifyRequest) => ({ ...body(req), partyId: params(req).partyId });
  app.put('/parties/:partyId', commandRoute(c, updateParty, partyId));
  app.post('/parties/:partyId/archive', commandRoute(c, archiveParty, partyId));
  app.post('/parties/:partyId/reactivate', commandRoute(c, reactivateParty, partyId));

  // Items
  app.get('/items', queryRoute(q, listItems, queryString));
  app.get('/items/:itemId', queryRoute(q, getItem, params));
  app.post('/items', commandRoute(c, createItem, body, 201));
  const itemId = (req: FastifyRequest) => ({ ...body(req), itemId: params(req).itemId });
  app.put('/items/:itemId', commandRoute(c, updateItem, itemId));
  app.post('/items/:itemId/archive', commandRoute(c, archiveItem, itemId));
  app.post('/items/:itemId/reactivate', commandRoute(c, reactivateItem, itemId));

  // Sales invoices
  app.get('/sales-invoices', queryRoute(q, listInvoices, queryString));
  app.get('/sales-invoices/:invoiceId', queryRoute(q, getInvoice, params));
  app.post('/sales-invoices', commandRoute(c, createInvoiceDraft, body, 201));
  app.put(
    '/sales-invoices/:invoiceId',
    commandRoute(c, updateInvoiceDraft, (req) => ({
      ...body(req),
      invoiceId: params(req).invoiceId,
    })),
  );
  app.delete(
    '/sales-invoices/:invoiceId',
    commandRoute(c, deleteInvoiceDraft, (req) => ({
      invoiceId: params(req).invoiceId,
      expectedVersion: Number(queryString(req).expectedVersion),
    })),
  );
  app.post(
    '/sales-invoices/:invoiceId/issue',
    commandRoute(c, issueInvoice, (req) => ({ ...body(req), invoiceId: params(req).invoiceId })),
  );
  app.post(
    '/sales-invoices/:invoiceId/cancel',
    commandRoute(c, cancelInvoice, (req) => ({ ...body(req), invoiceId: params(req).invoiceId })),
  );

  // Credit notes (always against one issued invoice)
  app.post(
    '/sales-invoices/:invoiceId/credit-notes',
    commandRoute(
      c,
      createCreditNoteDraft,
      (req) => ({ ...body(req), invoiceId: params(req).invoiceId }),
      201,
    ),
  );
  app.get('/credit-notes', queryRoute(q, listCreditNotes, queryString));
  app.get('/credit-notes/:creditNoteId', queryRoute(q, getCreditNote, params));
  app.put(
    '/credit-notes/:creditNoteId',
    commandRoute(c, updateCreditNoteDraft, (req) => ({
      ...body(req),
      creditNoteId: params(req).creditNoteId,
    })),
  );
  app.delete(
    '/credit-notes/:creditNoteId',
    commandRoute(c, deleteCreditNoteDraft, (req) => ({
      creditNoteId: params(req).creditNoteId,
      expectedVersion: Number(queryString(req).expectedVersion),
    })),
  );
  app.post(
    '/credit-notes/:creditNoteId/issue',
    commandRoute(c, issueCreditNote, (req) => ({
      ...body(req),
      creditNoteId: params(req).creditNoteId,
    })),
  );

  // Receipts & receivables (sales-to-cash)
  app.get('/receipts', queryRoute(q, listReceipts, queryString));
  app.get('/receipts/:receiptId', queryRoute(q, getReceipt, params));
  app.post('/receipts', commandRoute(c, recordReceipt, body, 201));
  app.post(
    '/receipts/:receiptId/allocations',
    commandRoute(c, allocateReceipt, (req) => ({ ...body(req), receiptId: params(req).receiptId })),
  );
  app.get('/receivables/summary', queryRoute(q, getReceivablesSummary));
  app.get('/receivables/open-invoices', queryRoute(q, listOpenInvoices, queryString));

  // Documents
  const documentContent = getDocumentContentQuery(deps.blobStore);
  app.get('/documents/:documentId/content', async (req, reply) => {
    const doc = await q.execute(documentContent, params(req), req.actor);
    const disposition =
      (req.query as Record<string, string | undefined>).download === '1' ? 'attachment' : 'inline';
    return reply
      .header('content-type', doc.mimeType)
      .header('content-disposition', `${disposition}; filename="${doc.filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, max-age=3600, immutable')
      .send(doc.content);
  });

  // Users (administration) and your own account
  app.get('/users', queryRoute(q, listUsers));
  app.post('/users', commandRoute(c, createUser, body, 201));
  const userId = (req: FastifyRequest) => ({ ...body(req), userId: params(req).userId });
  app.put('/users/:userId/roles', commandRoute(c, setUserRoles, userId));
  app.post('/users/:userId/deactivate', commandRoute(c, deactivateUser, userId));
  app.post('/users/:userId/reactivate', commandRoute(c, reactivateUser, userId));
  app.post('/users/:userId/reset-password', commandRoute(c, resetUserPassword, userId));
  app.post('/account/password', commandRoute(c, changeOwnPassword, body));

  // Inventory: warehouses, stock on hand, the stock ledger and compensating adjustments
  app.get('/inventory/warehouses', queryRoute(q, listWarehouses));
  app.post('/inventory/warehouses', commandRoute(c, createWarehouse, body, 201));
  app.get('/inventory/stock', queryRoute(q, listStock, queryString));
  app.get('/inventory/movements', queryRoute(q, listStockMovements, queryString));
  app.post('/inventory/adjustments', commandRoute(c, adjustStock, body, 201));

  // Purchasing: purchase orders
  app.get('/purchase-orders', queryRoute(q, listPurchaseOrders, queryString));
  app.get('/purchase-orders/:orderId', queryRoute(q, getPurchaseOrder, params));
  app.post('/purchase-orders', commandRoute(c, createPurchaseOrderDraft, body, 201));
  const orderId = (req: FastifyRequest) => ({ ...body(req), orderId: params(req).orderId });
  app.put('/purchase-orders/:orderId', commandRoute(c, updatePurchaseOrderDraft, orderId));
  app.delete(
    '/purchase-orders/:orderId',
    commandRoute(c, deletePurchaseOrderDraft, (req) => ({
      orderId: params(req).orderId,
      expectedVersion: Number(queryString(req).expectedVersion),
    })),
  );
  app.post('/purchase-orders/:orderId/approve', commandRoute(c, approvePurchaseOrder, orderId));
  app.post('/purchase-orders/:orderId/cancel', commandRoute(c, cancelPurchaseOrder, orderId));
  app.post('/purchase-orders/:orderId/close', commandRoute(c, closePurchaseOrder, orderId));
  app.get('/goods-receipts', queryRoute(q, listGoodsReceipts, queryString));
  app.get('/goods-receipts/:grnId', queryRoute(q, getGoodsReceipt, params));
  app.post('/goods-receipts', commandRoute(c, recordGoodsReceipt, body, 201));

  // Purchasing: supplier bills (purchase invoices) and the three-way match
  app.get('/purchase-invoices', queryRoute(q, listPurchaseInvoices, queryString));
  app.get('/purchase-invoices/:invoiceId', queryRoute(q, getPurchaseInvoice, params));
  app.get('/purchase-invoices/:invoiceId/match', queryRoute(q, matchPurchaseInvoice, params));
  app.post('/purchase-invoices', commandRoute(c, createPurchaseInvoiceDraft, body, 201));
  const purchaseInvoiceId = (req: FastifyRequest) => ({
    ...body(req),
    invoiceId: params(req).invoiceId,
  });
  app.put(
    '/purchase-invoices/:invoiceId',
    commandRoute(c, updatePurchaseInvoiceDraft, purchaseInvoiceId),
  );
  app.delete(
    '/purchase-invoices/:invoiceId',
    commandRoute(c, deletePurchaseInvoiceDraft, (req) => ({
      invoiceId: params(req).invoiceId,
      expectedVersion: Number(queryString(req).expectedVersion),
    })),
  );
  app.post(
    '/purchase-invoices/:invoiceId/post',
    commandRoute(c, postPurchaseInvoice, purchaseInvoiceId),
  );

  // Supplier bank details (RESTRICTED, maker-checker)
  app.get(
    '/parties/:partyId/bank-accounts',
    queryRoute(q, listBankAccounts, (req) => ({ partyId: params(req).partyId })),
  );
  app.post(
    '/parties/:partyId/bank-accounts',
    commandRoute(c, proposeBankAccount, (req) => ({ ...body(req), partyId: params(req).partyId })),
  );
  const bankAccountId = (req: FastifyRequest) => ({
    ...body(req),
    bankAccountId: params(req).bankAccountId,
  });
  app.post(
    '/bank-accounts/:bankAccountId/approve',
    commandRoute(c, approveBankAccount, bankAccountId),
  );
  app.post(
    '/bank-accounts/:bankAccountId/reject',
    commandRoute(c, rejectBankAccount, bankAccountId),
  );

  // Payables: what we owe suppliers, and supplier payments (maker-checker)
  app.get('/payables/summary', queryRoute(q, getPayablesSummary));
  app.get('/payables/open-invoices', queryRoute(q, listOpenPayables, queryString));
  app.get('/supplier-payments', queryRoute(q, listSupplierPayments, queryString));
  app.get('/supplier-payments/:paymentId', queryRoute(q, getSupplierPayment, params));
  app.post('/supplier-payments', commandRoute(c, requestSupplierPayment, body, 201));
  const paymentId = (req: FastifyRequest) => ({ ...body(req), paymentId: params(req).paymentId });
  app.post(
    '/supplier-payments/:paymentId/approve',
    commandRoute(c, approveSupplierPayment, paymentId),
  );
  app.post(
    '/supplier-payments/:paymentId/reject',
    commandRoute(c, rejectSupplierPayment, paymentId),
  );
  app.post(
    '/supplier-payments/:paymentId/allocations',
    commandRoute(c, allocateSupplierPayment, paymentId),
  );

  // Operations: background jobs
  app.get('/operations/outbox', queryRoute(q, listOutboxEvents, queryString));
  app.post(
    '/operations/outbox/:eventId/retry',
    commandRoute(c, retryOutboxEvent, (req) => ({ eventId: params(req).eventId })),
  );

  // Audit & dashboard
  app.get('/audit-events', queryRoute(q, listAuditEvents, queryString));
  app.get('/dashboard', queryRoute(q, getDashboard));
}

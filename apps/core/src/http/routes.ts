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
  changeOwnPassword,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetUserPassword,
  setUserRoles,
} from '../modules/identity';
import {
  archiveParty,
  createParty,
  getParty,
  listParties,
  reactivateParty,
  updateParty,
} from '../modules/parties';
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

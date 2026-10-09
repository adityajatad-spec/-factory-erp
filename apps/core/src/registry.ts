import { getDashboard } from './modules/analytics';
import { listAuditEvents } from './modules/audit';
import {
  archiveItem,
  createItem,
  getItem,
  listHsnCodes,
  listItems,
  listUoms,
  reactivateItem,
  updateItem,
} from './modules/catalog';
import { getCompany, listStates } from './modules/company';
import { getAiPolicy, setAiPolicy, viewAiPolicy } from './modules/copilot';
import { getDocumentContentQuery } from './modules/documents';
import { listOutboxEvents, retryOutboxEvent } from './modules/operations';
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
} from './modules/purchasing';

import {
  adjustStock,
  createWarehouse,
  listStock,
  listStockMovements,
  listWarehouses,
} from './modules/inventory';
import {
  changeOwnPassword,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetUserPassword,
  setUserRoles,
} from './modules/identity';
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
} from './modules/parties';
import {
  allocateSupplierPayment,
  approveSupplierPayment,
  getPayablesSummary,
  getSupplierPayment,
  listOpenPayables,
  listSupplierPayments,
  rejectSupplierPayment,
  requestSupplierPayment,
} from './modules/payables';
import {
  allocateReceipt,
  getReceipt,
  getReceivablesSummary,
  listOpenInvoices,
  listReceipts,
  recordReceipt,
} from './modules/receivables';
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
} from './modules/sales';
import type { BlobStore } from './platform/blob-store';
import type { AnyCommand } from './platform/commands';
import type { AnyQuery } from './platform/queries';

/**
 * Every command and query the system offers. This list is the single inventory that the
 * isolation harness, the AI-tier checks and (later) the AI tool registry are built from;
 * src/registry.test.ts fails if a definition exists in the code but is missing here.
 */
export function buildRegistry(deps: { blobStore: BlobStore }): {
  commands: readonly AnyCommand[];
  queries: readonly AnyQuery[];
} {
  return {
    commands: [
      createParty,
      updateParty,
      archiveParty,
      reactivateParty,
      createItem,
      updateItem,
      archiveItem,
      reactivateItem,
      createInvoiceDraft,
      updateInvoiceDraft,
      deleteInvoiceDraft,
      issueInvoice,
      cancelInvoice,
      createCreditNoteDraft,
      updateCreditNoteDraft,
      deleteCreditNoteDraft,
      issueCreditNote,
      recordReceipt,
      allocateReceipt,
      createUser,
      setUserRoles,
      deactivateUser,
      reactivateUser,
      resetUserPassword,
      changeOwnPassword,
      retryOutboxEvent,
      createWarehouse,
      adjustStock,
      createPurchaseOrderDraft,
      updatePurchaseOrderDraft,
      deletePurchaseOrderDraft,
      approvePurchaseOrder,
      cancelPurchaseOrder,
      closePurchaseOrder,
      recordGoodsReceipt,
      createPurchaseInvoiceDraft,
      updatePurchaseInvoiceDraft,
      deletePurchaseInvoiceDraft,
      postPurchaseInvoice,
      requestSupplierPayment,
      approveSupplierPayment,
      rejectSupplierPayment,
      allocateSupplierPayment,
      proposeBankAccount,
      approveBankAccount,
      rejectBankAccount,
      setAiPolicy,
    ],
    queries: [
      getCompany,
      listStates,
      listHsnCodes,
      listUoms,
      listParties,
      getParty,
      listItems,
      getItem,
      listInvoices,
      getInvoice,
      listCreditNotes,
      getCreditNote,
      listReceipts,
      getReceipt,
      listOpenInvoices,
      getReceivablesSummary,
      listAuditEvents,
      getDocumentContentQuery(deps.blobStore),
      getDashboard,
      listUsers,
      listOutboxEvents,
      listWarehouses,
      listStock,
      listStockMovements,
      listPurchaseOrders,
      getPurchaseOrder,
      listGoodsReceipts,
      getGoodsReceipt,
      listPurchaseInvoices,
      getPurchaseInvoice,
      matchPurchaseInvoice,
      listSupplierPayments,
      getSupplierPayment,
      listOpenPayables,
      getPayablesSummary,
      listBankAccounts,
      getAiPolicy,
      viewAiPolicy,
    ],
  };
}

/** Public API of the finance module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { financeKpis } from './insights';
export {
  postCreditNoteToLedger,
  postInvoiceCancellation,
  postReceiptToLedger,
  postSalesInvoiceReceivable,
} from './ledger';
export { postPurchaseInvoicePayable, postSupplierPaymentToPayables } from './payables-ledger';

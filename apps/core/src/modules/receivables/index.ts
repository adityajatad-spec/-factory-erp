/** Public API of the receivables module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { allocateReceipt, recordReceipt } from './commands';
export { receivablesKpis } from './insights';
export { getReceipt, listOpenInvoices, listReceipts } from './queries';
export { getReceivablesSummary } from './summary';

import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../db/database';
import { uuidv7 } from '../../platform/ids';

/**
 * The supplier payable ledger: what we owe each supplier, append-only. A posted purchase
 * invoice credits it; an approved supplier payment debits it. As with customers (R2-D4),
 * Tally remains the official books: no general-ledger posting happens here.
 */
export async function postPurchaseInvoicePayable(
  tx: DbTransaction,
  args: {
    companyId: string;
    supplierId: string;
    purchaseInvoiceId: string;
    invoiceNumber: string;
    supplierInvoiceNumber: string;
    invoiceDate: string;
    grandTotal: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  // A zero-value bill changes no balance; the ledger only holds non-zero movements.
  if (Money.of(args.grandTotal).isZero()) return;
  await tx
    .insertInto('finance.payableLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.supplierId,
      entryDate: args.invoiceDate,
      entryType: 'PURCHASE_INVOICE',
      sourceType: 'purchase.invoice',
      sourceId: args.purchaseInvoiceId,
      debit: '0',
      credit: args.grandTotal,
      narration: `Purchase invoice ${args.invoiceNumber} (supplier bill ${args.supplierInvoiceNumber})`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

/** Record an approved supplier payment as a debit on what we owe that supplier. */
export async function postSupplierPaymentToPayables(
  tx: DbTransaction,
  args: {
    companyId: string;
    supplierId: string;
    paymentId: string;
    paymentNumber: string;
    paymentDate: string;
    amount: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .insertInto('finance.payableLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.supplierId,
      entryDate: args.paymentDate,
      entryType: 'SUPPLIER_PAYMENT',
      sourceType: 'finance.supplier_payment',
      sourceId: args.paymentId,
      debit: args.amount,
      credit: '0',
      narration: `Supplier payment ${args.paymentNumber}`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

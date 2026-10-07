import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../db/database';
import { uuidv7 } from '../../platform/ids';

/**
 * Record an issued sales invoice in the customer's balance (append-only party ledger).
 * R2-D4: V1 keeps immutable vouchers + customer/supplier balances; Tally remains the official
 * books, so no general-ledger posting happens here.
 */
export async function postSalesInvoiceReceivable(
  tx: DbTransaction,
  args: {
    companyId: string;
    customerId: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    grandTotal: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  // A zero-value invoice changes no balance; the ledger only holds non-zero movements.
  if (Money.of(args.grandTotal).isZero()) return;
  await tx
    .insertInto('finance.partyLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.customerId,
      entryDate: args.invoiceDate,
      entryType: 'SALES_INVOICE',
      sourceType: 'sales.invoice',
      sourceId: args.invoiceId,
      debit: args.grandTotal,
      credit: '0',
      narration: `Sales invoice ${args.invoiceNumber}`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

/** Record a customer receipt as a credit on the customer's balance (append-only). */
export async function postReceiptToLedger(
  tx: DbTransaction,
  args: {
    companyId: string;
    customerId: string;
    receiptId: string;
    receiptNumber: string;
    receiptDate: string;
    amount: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .insertInto('finance.partyLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.customerId,
      entryDate: args.receiptDate,
      entryType: 'RECEIPT',
      sourceType: 'finance.receipt',
      sourceId: args.receiptId,
      debit: '0',
      credit: args.amount,
      narration: `Receipt ${args.receiptNumber}`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

/**
 * Reverse a cancelled invoice in the customer's balance: a NEW credit entry equal to the
 * invoice's debit. The original debit stays — history is never edited.
 */
export async function postInvoiceCancellation(
  tx: DbTransaction,
  args: {
    companyId: string;
    customerId: string;
    invoiceId: string;
    invoiceNumber: string;
    cancellationDate: string;
    grandTotal: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  // A zero-value invoice posted nothing, so there is nothing to reverse.
  if (Money.of(args.grandTotal).isZero()) return;
  await tx
    .insertInto('finance.partyLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.customerId,
      entryDate: args.cancellationDate,
      entryType: 'INVOICE_CANCELLATION',
      sourceType: 'sales.invoice',
      sourceId: args.invoiceId,
      debit: '0',
      credit: args.grandTotal,
      narration: `Cancellation of sales invoice ${args.invoiceNumber}`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

/** Record an issued credit note as a credit on the customer's balance (append-only). */
export async function postCreditNoteToLedger(
  tx: DbTransaction,
  args: {
    companyId: string;
    customerId: string;
    creditNoteId: string;
    creditNoteNumber: string;
    invoiceNumber: string;
    creditNoteDate: string;
    grandTotal: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .insertInto('finance.partyLedgerEntries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      partyId: args.customerId,
      entryDate: args.creditNoteDate,
      entryType: 'CREDIT_NOTE',
      sourceType: 'sales.credit_note',
      sourceId: args.creditNoteId,
      debit: '0',
      credit: args.grandTotal,
      narration: `Credit note ${args.creditNoteNumber} against invoice ${args.invoiceNumber}`,
      createdAt: args.now,
      createdBy: args.userId,
    })
    .execute();
}

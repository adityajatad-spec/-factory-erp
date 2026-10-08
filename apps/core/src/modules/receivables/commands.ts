import { AllocateReceiptRequest, PERMISSIONS, RecordReceiptRequest } from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { allocateDocumentNumber } from '../../platform/numbering';
import { postReceiptToLedger } from '../finance';
import { applyAllocations, invoiceAuditRecords } from './allocate';
import { loadReceiptDto } from './receipt-dto';

/**
 * Record money received from a customer, optionally allocating it to invoices.
 * One transaction: number → receipt → customer-balance credit → allocations → audit.
 * The receipt is immutable afterwards; any unallocated remainder stays on account.
 */
export const recordReceipt = defineCommand({
  name: 'finance.receipt.record',
  description:
    'Record a payment received from a customer and optionally allocate it to issued invoices.',
  input: RecordReceiptRequest,
  permission: PERMISSIONS.receiptRecord,
  // Money movements are confirmed by a human; the AI may only propose them.
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const today = businessDate(now);
    if (input.receiptDate > today) {
      throw new BusinessRuleError(
        'RECEIPT_DATE_IN_FUTURE',
        `Receipt date ${input.receiptDate} is after today (${today})`,
      );
    }

    const customer = await tx
      .selectFrom('party.parties')
      .select(['id', 'name', 'status', 'isCustomer'])
      .where('companyId', '=', companyId)
      .where('id', '=', input.customerId)
      .executeTakeFirst();
    if (!customer) throw new NotFoundError('Customer');
    if (customer.status !== 'ACTIVE' || !customer.isCustomer) {
      throw new BusinessRuleError(
        'NOT_AN_ACTIVE_CUSTOMER',
        `${customer.name} is not an active customer`,
      );
    }

    const company = await tx
      .selectFrom('platform.companies')
      .select('receiptPrefix')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'RECEIPT',
      prefix: company.receiptPrefix,
      documentDate: input.receiptDate,
      now,
    });

    const receiptId = uuidv7(now.getTime());
    const amount = Money.of(input.amount).toString();
    await tx
      .insertInto('finance.receipts')
      .values({
        id: receiptId,
        companyId,
        receiptNumber: documentNumber,
        fiscalYear,
        receiptDate: input.receiptDate,
        customerId: input.customerId,
        amount,
        paymentMode: input.paymentMode,
        reference: input.reference,
        notes: input.notes,
        createdAt: now,
        createdBy: actor.user.id,
      })
      .execute();

    await postReceiptToLedger(tx, {
      companyId,
      customerId: input.customerId,
      receiptId,
      receiptNumber: documentNumber,
      receiptDate: input.receiptDate,
      amount,
      userId: actor.user.id,
      now,
    });

    const applied = input.allocations.length
      ? await applyAllocations(tx, {
          companyId,
          receipt: { id: receiptId, customerId: input.customerId, amount, alreadyAllocated: '0' },
          requests: input.allocations,
          userId: actor.user.id,
          now,
        })
      : [];

    const receipt = await loadReceiptDto(tx, companyId, receiptId);
    return {
      result: receipt,
      audit: [
        {
          entityType: 'finance.receipt',
          entityId: receiptId,
          after: {
            receiptNumber: documentNumber,
            customerId: input.customerId,
            receiptDate: input.receiptDate,
            amount,
            paymentMode: input.paymentMode,
            allocatedAmount: receipt.allocatedAmount,
            unallocatedAmount: receipt.unallocatedAmount,
          },
        },
        ...invoiceAuditRecords(applied, documentNumber),
      ],
    };
  },
});

/** Allocate (part of) a receipt's unallocated amount to issued invoices. */
export const allocateReceipt = defineCommand({
  name: 'finance.receipt.allocate',
  description: "Allocate a receipt's unallocated amount to one or more issued invoices.",
  input: AllocateReceiptRequest,
  permission: PERMISSIONS.receiptRecord,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    // Lock the receipt first: concurrent allocations of the same receipt serialise here.
    const receipt = await tx
      .selectFrom('finance.receipts')
      .select(['id', 'receiptNumber', 'customerId', 'amount'])
      .where('companyId', '=', companyId)
      .where('id', '=', input.receiptId)
      .forUpdate()
      .executeTakeFirst();
    if (!receipt) throw new NotFoundError('Receipt');

    const already = await tx
      .selectFrom('finance.receiptAllocations')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.val('0')).as('total'))
      .where('receiptId', '=', receipt.id)
      .executeTakeFirstOrThrow();
    const alreadyAllocated = Money.of(already.total).toString();
    const unallocatedBefore = Money.of(receipt.amount).minus(Money.of(alreadyAllocated));

    const applied = await applyAllocations(tx, {
      companyId,
      receipt: {
        id: receipt.id,
        customerId: receipt.customerId,
        amount: receipt.amount,
        alreadyAllocated,
      },
      requests: input.allocations,
      userId: actor.user.id,
      now,
    });

    const result = await loadReceiptDto(tx, companyId, receipt.id);
    return {
      result,
      audit: [
        {
          entityType: 'finance.receipt',
          entityId: receipt.id,
          before: { unallocatedAmount: unallocatedBefore.toString() },
          after: { unallocatedAmount: result.unallocatedAmount },
        },
        ...invoiceAuditRecords(applied, receipt.receiptNumber),
      ],
    };
  },
});

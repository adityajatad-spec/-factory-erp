import {
  AllocateSupplierPaymentRequest,
  PERMISSIONS,
  RejectSupplierPaymentRequest,
  RequestSupplierPaymentRequest,
  SupplierPaymentVersionRequest,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../db/database';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { toJsonb } from '../../platform/json';
import { allocateDocumentNumber } from '../../platform/numbering';
import { postSupplierPaymentToPayables } from '../finance';
import { loadSupplier, outstandingOfPurchase } from '../purchasing';
import { applySupplierAllocations, billAuditRecords } from './allocate';
import { checkSupplierAllocations } from './domain';
import { loadSupplierPaymentDto } from './dto';

function assertNotFutureDated(paymentDate: string, now: Date) {
  const today = businessDate(now);
  if (paymentDate > today) {
    throw new BusinessRuleError(
      'PAYMENT_DATE_IN_FUTURE',
      `Payment date ${paymentDate} is after today (${today})`,
    );
  }
}

/**
 * Record a payment made (or to be released) to a supplier, for someone else to approve.
 * Nothing changes what we owe until it is approved; the proposed allocations are checked now
 * so obvious mistakes surface early, and checked again — under lock — on approval.
 */
export const requestSupplierPayment = defineCommand({
  name: 'finance.supplierPayment.request',
  description:
    'Record a payment to a supplier for approval by a second person, optionally saying which bills it settles.',
  input: RequestSupplierPaymentRequest,
  permission: PERMISSIONS.supplierPaymentRequest,
  // Money movements are confirmed by a human; the AI may only propose them.
  ai: { tier: 'CONFIRM' },
  examples: [
    {
      description: 'Prepare a supplier payment for these invoices',
      input: {
        supplierId: '01900000-0000-7000-8000-000000000003',
        paymentDate: '2026-10-08',
        amount: '47200.00',
        paymentMode: 'BANK_TRANSFER',
        reference: 'NEFT N281260012345',
        allocations: [
          { purchaseInvoiceId: '01900000-0000-7000-8000-000000000007', amount: '40414.00' },
          { purchaseInvoiceId: '01900000-0000-7000-8000-000000000008', amount: '6786.00' },
        ],
      },
    },
  ],
  handler: async ({ tx, actor, companyId, now }, input) => {
    assertNotFutureDated(input.paymentDate, now);
    await loadSupplier(tx, companyId, input.supplierId);
    const amount = Money.of(input.amount).toString();

    if (input.allocations.length) {
      // Read-only check (no locks): the binding check happens on approval.
      const bills = await currentBills(
        tx,
        companyId,
        input.allocations.map((a) => a.purchaseInvoiceId),
      );
      const { issues } = checkSupplierAllocations({
        supplierId: input.supplierId,
        available: Money.of(amount),
        bills,
        requests: input.allocations,
      });
      const first = issues[0];
      if (first) {
        throw new BusinessRuleError(
          first.rule,
          issues.map((i) => i.message).join('; '),
          issues.map(({ path, message }) => ({ path, message })),
        );
      }
    }

    const id = uuidv7(now.getTime());
    const proposed = input.allocations.map((a) => ({
      purchaseInvoiceId: a.purchaseInvoiceId,
      amount: Money.of(a.amount).toString(),
    }));
    await tx
      .insertInto('finance.supplierPayments')
      .values({
        id,
        companyId,
        supplierId: input.supplierId,
        status: 'PENDING_APPROVAL',
        paymentDate: input.paymentDate,
        amount,
        paymentMode: input.paymentMode,
        reference: input.reference,
        notes: input.notes,
        proposedAllocations: toJsonb(proposed),
        requestedAt: now,
        requestedBy: actor.user.id,
      })
      .execute();
    const payment = await loadSupplierPaymentDto(tx, companyId, id);
    return {
      result: payment,
      audit: [
        {
          entityType: 'finance.supplier_payment',
          entityId: id,
          after: {
            status: 'PENDING_APPROVAL',
            supplierId: input.supplierId,
            paymentDate: input.paymentDate,
            amount,
            paymentMode: input.paymentMode,
            proposedAllocations: proposed,
          },
        },
      ],
    };
  },
});

/** Bills as they stand, without locking (for the early check on a request). */
async function currentBills(tx: DbTransaction, companyId: string, ids: readonly string[]) {
  const rows = await tx
    .selectFrom('purchase.invoices as pi')
    .select(['pi.id', 'pi.invoiceNumber', 'pi.supplierInvoiceNumber', 'pi.supplierId'])
    .select(['pi.status', 'pi.grandTotal'])
    .select((eb) =>
      eb
        .selectFrom('finance.supplierPaymentAllocations as a')
        .select((e) => e.fn.coalesce(e.fn.sum<string>('a.amount'), e.val('0')).as('paid'))
        .whereRef('a.purchaseInvoiceId', '=', 'pi.id')
        .as('paid'),
    )
    .where('pi.companyId', '=', companyId)
    .where('pi.id', 'in', [...new Set(ids)])
    .execute();
  return new Map(
    rows.map((b) => [
      b.id,
      {
        id: b.id,
        label: b.invoiceNumber ?? `draft bill ${b.supplierInvoiceNumber}`,
        supplierId: b.supplierId,
        status: b.status,
        outstanding: Money.of(
          outstandingOfPurchase(b.grandTotal, Money.of(b.paid ?? '0').toString()),
        ),
      },
    ]),
  );
}

async function lockPayment(
  tx: DbTransaction,
  companyId: string,
  paymentId: string,
  expectedVersion: number | null,
) {
  const p = await tx
    .selectFrom('finance.supplierPayments')
    .selectAll()
    .where('companyId', '=', companyId)
    .where('id', '=', paymentId)
    .forUpdate()
    .executeTakeFirst();
  if (!p) throw new NotFoundError('Supplier payment');
  if (expectedVersion !== null && p.version !== expectedVersion) {
    throw new VersionConflictError('Supplier payment');
  }
  return p;
}

function assertPending(p: { status: string; paymentNumber: string | null }) {
  if (p.status !== 'PENDING_APPROVAL') {
    throw new BusinessRuleError(
      'SUPPLIER_PAYMENT_NOT_PENDING',
      `This supplier payment${p.paymentNumber ? ` (${p.paymentNumber})` : ''} is already ${p.status}`,
    );
  }
}

/**
 * Approve someone else's payment request — one transaction: lock it → maker ≠ checker →
 * number it → debit the supplier's payable → settle the proposed bills (re-checked under lock,
 * all or nothing) → audit. Approving your own request is refused here and by SQL.
 */
export const approveSupplierPayment = defineCommand({
  name: 'finance.supplierPayment.approve',
  description:
    "Approve another user's supplier payment: it is numbered, reduces what we owe and settles the proposed bills.",
  input: SupplierPaymentVersionRequest,
  permission: PERMISSIONS.supplierPaymentApprove,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockPayment(tx, companyId, input.paymentId, input.expectedVersion);
    assertPending(before);
    if (before.requestedBy === actor.user.id) {
      throw new BusinessRuleError(
        'SELF_APPROVAL',
        'You recorded this payment; a different person must approve it',
      );
    }
    assertNotFutureDated(before.paymentDate, now);

    const company = await tx
      .selectFrom('platform.companies')
      .select('supplierPaymentPrefix')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    // Numbered by approval date: requests may be approved in any order.
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'SUPPLIER_PAYMENT',
      prefix: company.supplierPaymentPrefix,
      documentDate: businessDate(now),
      now,
    });
    await tx
      .updateTable('finance.supplierPayments')
      .set({
        status: 'APPROVED',
        paymentNumber: documentNumber,
        fiscalYear,
        approvedAt: now,
        approvedBy: actor.user.id,
        version: before.version + 1,
      })
      .where('id', '=', before.id)
      .execute();

    await postSupplierPaymentToPayables(tx, {
      companyId,
      supplierId: before.supplierId,
      paymentId: before.id,
      paymentNumber: documentNumber,
      paymentDate: before.paymentDate,
      amount: before.amount,
      userId: actor.user.id,
      now,
    });

    const applied = await applySupplierAllocations(tx, {
      companyId,
      payment: {
        id: before.id,
        supplierId: before.supplierId,
        amount: before.amount,
        alreadyAllocated: '0',
      },
      requests: before.proposedAllocations as unknown as Array<{
        purchaseInvoiceId: string;
        amount: string;
      }>,
      userId: actor.user.id,
      now,
    });

    const payment = await loadSupplierPaymentDto(tx, companyId, before.id);
    return {
      result: payment,
      audit: [
        {
          entityType: 'finance.supplier_payment',
          entityId: before.id,
          before: { status: 'PENDING_APPROVAL', version: before.version },
          after: {
            status: 'APPROVED',
            paymentNumber: documentNumber,
            amount: payment.amount,
            allocatedAmount: payment.allocatedAmount,
            unallocatedAmount: payment.unallocatedAmount,
            requestedBy: before.requestedBy,
            approvedBy: actor.user.id,
          },
        },
        ...billAuditRecords(applied, documentNumber),
      ],
    };
  },
});

export const rejectSupplierPayment = defineCommand({
  name: 'finance.supplierPayment.reject',
  description: 'Reject a pending supplier payment, with a reason. It changes nothing owed.',
  input: RejectSupplierPaymentRequest,
  permission: PERMISSIONS.supplierPaymentApprove,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockPayment(tx, companyId, input.paymentId, input.expectedVersion);
    assertPending(before);
    await tx
      .updateTable('finance.supplierPayments')
      .set({
        status: 'REJECTED',
        rejectedAt: now,
        rejectedBy: actor.user.id,
        rejectionReason: input.reason,
        version: before.version + 1,
      })
      .where('id', '=', before.id)
      .execute();
    const payment = await loadSupplierPaymentDto(tx, companyId, before.id);
    return {
      result: payment,
      audit: [
        {
          entityType: 'finance.supplier_payment',
          entityId: before.id,
          before: { status: 'PENDING_APPROVAL', version: before.version },
          after: { status: 'REJECTED', reason: input.reason },
        },
      ],
    };
  },
});

/** Allocate money held on account (an approved payment's unallocated part) to posted bills. */
export const allocateSupplierPayment = defineCommand({
  name: 'finance.supplierPayment.allocate',
  description:
    "Allocate an approved supplier payment's unallocated (on-account) amount to one or more posted bills.",
  input: AllocateSupplierPaymentRequest,
  permission: PERMISSIONS.supplierPaymentRequest,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    // Lock the payment first: concurrent allocations of the same payment serialise here.
    const payment = await lockPayment(tx, companyId, input.paymentId, null);
    if (payment.status !== 'APPROVED') {
      throw new BusinessRuleError(
        'SUPPLIER_PAYMENT_NOT_APPROVED',
        `This payment is ${payment.status}; only approved payments can be allocated`,
      );
    }
    const already = await tx
      .selectFrom('finance.supplierPaymentAllocations')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.val('0')).as('total'))
      .where('paymentId', '=', payment.id)
      .executeTakeFirstOrThrow();
    const alreadyAllocated = Money.of(already.total).toString();
    const unallocatedBefore = Money.of(payment.amount).minus(Money.of(alreadyAllocated));

    const applied = await applySupplierAllocations(tx, {
      companyId,
      payment: {
        id: payment.id,
        supplierId: payment.supplierId,
        amount: payment.amount,
        alreadyAllocated,
      },
      requests: input.allocations,
      userId: actor.user.id,
      now,
    });

    const result = await loadSupplierPaymentDto(tx, companyId, payment.id);
    return {
      result,
      audit: [
        {
          entityType: 'finance.supplier_payment',
          entityId: payment.id,
          before: { unallocatedAmount: unallocatedBefore.toString() },
          after: { unallocatedAmount: result.unallocatedAmount },
        },
        ...billAuditRecords(applied, payment.paymentNumber),
      ],
    };
  },
});

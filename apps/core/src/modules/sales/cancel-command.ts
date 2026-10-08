import { CancelInvoiceRequest, PERMISSIONS } from '@factory-erp/contracts';
import { formatINR, Money } from '@factory-erp/money';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../platform/errors';
import { postInvoiceCancellation } from '../finance';
import { loadInvoiceDto } from './invoice-dto';
import { lockInvoicesForSettlement } from './settlement-lock';

/**
 * Cancel an issued invoice. In ONE transaction:
 * lock for settlement → check it is ISSUED, unpaid and uncredited → mark CANCELLED with who,
 * when and why → reverse it in the customer's balance with a new ledger entry → audit.
 *
 * Nothing is deleted: the invoice keeps its number, values, snapshots and PDF forever, and
 * the SQL guard makes the cancellation details write-once. An invoice that payments or credit
 * notes have touched cannot be cancelled — that would need a refund or un-allocation, which
 * are separate accounting decisions not modelled yet.
 * [VERIFY R-03/R-06] Whether and until when an issued tax invoice may be cancelled (rather than
 * credited) is a CA validation point; no time limit is enforced yet.
 */
export const cancelInvoice = defineCommand({
  name: 'sales.invoice.cancel',
  description:
    'Cancel an issued sales invoice that has no payments or credit notes. The invoice keeps its number and values; its amount is reversed from the customer balance.',
  input: CancelInvoiceRequest,
  permission: PERMISSIONS.salesInvoiceCancel,
  // A human must confirm. The AI may at most propose a cancellation.
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const [inv] = await lockInvoicesForSettlement(tx, companyId, [input.invoiceId]);
    if (!inv) throw new NotFoundError('Invoice');
    const number = inv.invoiceNumber ?? 'This invoice';
    if (inv.status === 'CANCELLED')
      throw new BusinessRuleError('INVOICE_ALREADY_CANCELLED', `${number} is already cancelled`);
    if (inv.status !== 'ISSUED') {
      throw new BusinessRuleError(
        'INVOICE_NOT_ISSUED',
        'Only issued invoices can be cancelled; a draft is simply deleted',
      );
    }
    if (inv.version !== input.expectedVersion) throw new VersionConflictError('Invoice');
    if (Money.of(inv.paidAmount).isPositive()) {
      throw new BusinessRuleError(
        'INVOICE_HAS_PAYMENTS',
        `${number} has ${formatINR(Money.of(inv.paidAmount))} of payments allocated, so it cannot be cancelled. Reversing payments is not supported yet.`,
      );
    }
    if (Money.of(inv.creditedAmount).isPositive()) {
      throw new BusinessRuleError(
        'INVOICE_HAS_CREDIT_NOTES',
        `${number} has issued credit notes, so it cannot be cancelled`,
      );
    }

    await tx
      .updateTable('sales.invoices')
      .set({
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledBy: actor.user.id,
        cancellationReason: input.reason,
        version: inv.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', inv.id)
      .execute();

    await postInvoiceCancellation(tx, {
      companyId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber ?? '',
      cancellationDate: businessDate(now),
      grandTotal: inv.grandTotal,
      userId: actor.user.id,
      now,
    });

    const invoice = await loadInvoiceDto(tx, companyId, inv.id);
    return {
      result: invoice,
      audit: [
        {
          entityType: 'sales.invoice',
          entityId: inv.id,
          before: { status: 'ISSUED', version: inv.version, outstandingAmount: inv.grandTotal },
          after: {
            status: 'CANCELLED',
            version: invoice.version,
            invoiceNumber: inv.invoiceNumber,
            reason: input.reason,
            reversedAmount: inv.grandTotal,
          },
        },
      ],
    };
  },
});

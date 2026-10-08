import { IssueInvoiceRequest, PERMISSIONS } from '@factory-erp/contracts';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../platform/errors';
import { toJsonb } from '../../platform/json';
import { postSalesInvoiceReceivable } from '../finance';
import { loadInvoiceDto } from './invoice-dto';
import { replaceInvoiceLines, totalsColumns } from './invoice-store';
import { allocateDocumentNumber } from '../../platform/numbering';
import { policyFromCompany, priceInvoice } from './pricing';
import { loadInvoiceableCustomer, loadSeller } from './snapshots';

export const INVOICE_ISSUED_TOPIC = 'sales.invoice.issued';

/**
 * Issue a draft invoice. In ONE transaction:
 * lock → validate → recalculate authoritatively → allocate gapless number → snapshot seller
 * and customer → mark ISSUED (immutable from here, enforced in SQL) → post customer balance
 * → audit → outbox event (PDF generation happens asynchronously from the outbox).
 */
export const issueInvoice = defineCommand({
  name: 'sales.invoice.issue',
  description: 'Issue a draft sales invoice: assigns the invoice number and makes it immutable.',
  input: IssueInvoiceRequest,
  permission: PERMISSIONS.salesInvoiceIssue,
  // A human must click "Issue". The AI may prepare drafts, never issue them.
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const draft = await tx
      .selectFrom('sales.invoices')
      .selectAll()
      .where('companyId', '=', companyId)
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (!draft) throw new NotFoundError('Invoice');
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleError(
        'INVOICE_NOT_DRAFT',
        `Invoice is already ${draft.status} (${draft.invoiceNumber ?? ''})`,
      );
    }
    if (draft.version !== input.expectedVersion) throw new VersionConflictError('Invoice');

    const today = businessDate(now);
    if (draft.invoiceDate > today) {
      throw new BusinessRuleError(
        'INVOICE_DATE_IN_FUTURE',
        `Invoice date ${draft.invoiceDate} is after today (${today})`,
      );
    }

    const { company, snapshot: seller } = await loadSeller(tx, companyId);
    const { snapshot: customer } = await loadInvoiceableCustomer(tx, companyId, draft.customerId);

    // Recalculate from current master data and the rates in force on the invoice date.
    const storedLines = await tx
      .selectFrom('sales.invoiceLines')
      .select(['itemId', 'description', 'quantity', 'unitRate', 'discountPercent'])
      .where('invoiceId', '=', draft.id)
      .orderBy('lineNo')
      .execute();
    if (storedLines.length === 0)
      throw new BusinessRuleError('INVOICE_HAS_NO_LINES', 'An invoice needs at least one line');

    const priced = await priceInvoice(tx, {
      companyId,
      invoiceDate: draft.invoiceDate,
      supplierStateCode: company.stateCode,
      placeOfSupplyStateCode: draft.placeOfSupplyStateCode,
      policy: policyFromCompany(company.invoiceRounding),
      lines: storedLines,
    });
    const recalculated = priced.calc.totals.grandTotal !== draft.grandTotal;
    await replaceInvoiceLines(tx, draft.id, priced.lines);

    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'SALES_INVOICE',
      prefix: company.invoicePrefix,
      documentDate: draft.invoiceDate,
      now,
    });

    await tx
      .updateTable('sales.invoices')
      .set({
        ...totalsColumns(priced.calc),
        supplierStateCode: company.stateCode,
        status: 'ISSUED',
        invoiceNumber: documentNumber,
        fiscalYear,
        sellerSnapshot: toJsonb(seller),
        customerSnapshot: toJsonb(customer),
        issuedAt: now,
        issuedBy: actor.user.id,
        version: draft.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', draft.id)
      .execute();

    await postSalesInvoiceReceivable(tx, {
      companyId,
      customerId: draft.customerId,
      invoiceId: draft.id,
      invoiceNumber: documentNumber,
      invoiceDate: draft.invoiceDate,
      grandTotal: priced.calc.totals.grandTotal,
      userId: actor.user.id,
      now,
    });

    const invoice = await loadInvoiceDto(tx, companyId, draft.id);
    return {
      result: invoice,
      audit: [
        {
          entityType: 'sales.invoice',
          entityId: draft.id,
          before: { status: 'DRAFT', version: draft.version, grandTotal: draft.grandTotal },
          after: {
            status: 'ISSUED',
            version: invoice.version,
            invoiceNumber: documentNumber,
            fiscalYear,
            grandTotal: invoice.grandTotal,
            calcEngineVersion: invoice.calcEngineVersion,
          },
          metadata: recalculated
            ? { recalculatedAtIssue: true, draftGrandTotal: draft.grandTotal }
            : undefined,
        },
      ],
      outbox: [
        {
          topic: INVOICE_ISSUED_TOPIC,
          aggregateType: 'sales.invoice',
          aggregateId: draft.id,
          payload: { invoiceId: draft.id, companyId },
        },
      ],
    };
  },
});

import {
  CreateCreditNoteDraftRequest,
  DeleteCreditNoteDraftRequest,
  IssueCreditNoteRequest,
  PERMISSIONS,
  UpdateCreditNoteDraftRequest,
} from '@factory-erp/contracts';
import { GstCalculationError } from '@factory-erp/gst';
import { Money } from '@factory-erp/money';
import type { DbTransaction } from '../../../db/database';
import { businessDate } from '../../../platform/clock';
import { defineCommand } from '../../../platform/commands';
import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../../../platform/errors';
import { uuidv7 } from '../../../platform/ids';
import { toJsonb } from '../../../platform/json';
import { allocateDocumentNumber } from '../../../platform/numbering';
import { postCreditNoteToLedger } from '../../finance/ledger';
import { totalsColumns } from '../invoice-store';
import { outstandingOf } from '../settlement';
import { loadInvoiceableCustomer, loadSeller } from '../snapshots';
import { loadCreditableInvoice, replaceCreditNoteLines } from './creditable';
import { loadCreditNoteDto } from './dto';
import { assessCreditNote, type CreditableInvoice, type CreditLineRequest } from './rules';

export const CREDIT_NOTE_ISSUED_TOPIC = 'sales.credit_note.issued';

/** Run the credit-note rules and price the lines; reject the request whole on any issue. */
function assessOrThrow(
  invoice: CreditableInvoice,
  request: { customerId: string; creditNoteDate: string; lines: readonly CreditLineRequest[] },
) {
  let assessed;
  try {
    assessed = assessCreditNote({ invoice, ...request });
  } catch (e) {
    if (e instanceof GstCalculationError)
      throw new ValidationError(e.issues, 'Credit note could not be calculated');
    throw e;
  }
  const first = assessed.issues[0];
  if (first || !assessed.calc || !assessed.lines) {
    throw new BusinessRuleError(
      first?.rule ?? 'CREDIT_NOTE_INVALID',
      assessed.issues.map((i) => i.message).join('; '),
      assessed.issues.map(({ path, message }) => ({ path, message })),
    );
  }
  return { calc: assessed.calc, lines: assessed.lines };
}

async function lockCreditNote(
  tx: DbTransaction,
  companyId: string,
  creditNoteId: string,
  expectedVersion: number,
) {
  const cn = await tx
    .selectFrom('sales.creditNotes')
    .selectAll()
    .where('companyId', '=', companyId)
    .where('id', '=', creditNoteId)
    .forUpdate()
    .executeTakeFirst();
  if (!cn) throw new NotFoundError('Credit note');
  if (cn.status !== 'DRAFT') {
    throw new BusinessRuleError(
      'CREDIT_NOTE_NOT_DRAFT',
      `Credit note ${cn.creditNoteNumber ?? ''} is already ${cn.status}; issued credit notes are permanent`,
    );
  }
  if (cn.version !== expectedVersion) throw new VersionConflictError('Credit note');
  return cn;
}

export const createCreditNoteDraft = defineCommand({
  name: 'sales.creditNote.createDraft',
  description:
    'Create a draft credit note against one issued invoice of the customer. Amounts and GST are computed by the server from the invoice lines.',
  input: CreateCreditNoteDraftRequest,
  permission: PERMISSIONS.creditNoteDraft,
  // Drafts change no balance; the AI may prepare them, a human issues them.
  ai: { tier: 'DRAFT' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const invoice = await loadCreditableInvoice(tx, companyId, input.invoiceId, { lock: false });
    const priced = assessOrThrow(invoice, input);
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('sales.creditNotes')
      .values({
        id,
        companyId,
        status: 'DRAFT',
        creditNoteDate: input.creditNoteDate,
        invoiceId: invoice.id,
        customerId: input.customerId,
        reasonCode: input.reasonCode,
        reason: input.reason,
        notes: input.notes,
        supplierStateCode: invoice.supplierStateCode,
        placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
        ...totalsColumns(priced.calc),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();
    await replaceCreditNoteLines(tx, id, invoice.id, priced.lines);

    const creditNote = await loadCreditNoteDto(tx, companyId, id);
    return {
      result: creditNote,
      audit: [
        {
          entityType: 'sales.credit_note',
          entityId: id,
          after: {
            status: 'DRAFT',
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            customerId: input.customerId,
            creditNoteDate: input.creditNoteDate,
            reasonCode: input.reasonCode,
            grandTotal: creditNote.grandTotal,
            lineCount: creditNote.lines.length,
          },
        },
      ],
    };
  },
});

export const updateCreditNoteDraft = defineCommand({
  name: 'sales.creditNote.updateDraft',
  description:
    'Replace the content of a draft credit note (optimistic concurrency via expectedVersion). Its invoice cannot change.',
  input: UpdateCreditNoteDraftRequest,
  permission: PERMISSIONS.creditNoteDraft,
  ai: { tier: 'DRAFT' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockCreditNote(tx, companyId, input.creditNoteId, input.expectedVersion);
    const invoice = await loadCreditableInvoice(tx, companyId, before.invoiceId, { lock: false });
    const priced = assessOrThrow(invoice, { ...input, customerId: before.customerId });
    await tx
      .updateTable('sales.creditNotes')
      .set({
        creditNoteDate: input.creditNoteDate,
        reasonCode: input.reasonCode,
        reason: input.reason,
        notes: input.notes,
        ...totalsColumns(priced.calc),
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();
    await replaceCreditNoteLines(tx, before.id, before.invoiceId, priced.lines);

    const creditNote = await loadCreditNoteDto(tx, companyId, before.id);
    return {
      result: creditNote,
      audit: [
        {
          entityType: 'sales.credit_note',
          entityId: before.id,
          before: {
            version: before.version,
            creditNoteDate: before.creditNoteDate,
            reasonCode: before.reasonCode,
            grandTotal: before.grandTotal,
          },
          after: {
            version: creditNote.version,
            creditNoteDate: creditNote.creditNoteDate,
            reasonCode: creditNote.reasonCode,
            grandTotal: creditNote.grandTotal,
          },
        },
      ],
    };
  },
});

export const deleteCreditNoteDraft = defineCommand({
  name: 'sales.creditNote.deleteDraft',
  description: 'Delete a draft credit note. Issued credit notes can never be deleted.',
  input: DeleteCreditNoteDraftRequest,
  permission: PERMISSIONS.creditNoteDraft,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, companyId }, input) => {
    const before = await lockCreditNote(tx, companyId, input.creditNoteId, input.expectedVersion);
    await tx.deleteFrom('sales.creditNotes').where('id', '=', before.id).execute();
    return {
      result: { deleted: true as const, creditNoteId: before.id },
      audit: [
        {
          entityType: 'sales.credit_note',
          entityId: before.id,
          before: {
            status: before.status,
            invoiceId: before.invoiceId,
            grandTotal: before.grandTotal,
            version: before.version,
          },
        },
      ],
    };
  },
});

/**
 * Issue a draft credit note. In ONE transaction:
 * lock the draft → lock the invoice for settlement → re-check every rule on the locked state
 * → recalculate → allocate the gapless number → snapshot seller and customer → mark ISSUED
 * (immutable from here, enforced in SQL) → credit the customer's balance → audit the credit
 * note and the invoice → outbox event (the PDF is generated asynchronously).
 */
export const issueCreditNote = defineCommand({
  name: 'sales.creditNote.issue',
  description:
    'Issue a draft credit note: assigns its number, reduces the invoice outstanding and makes it permanent.',
  input: IssueCreditNoteRequest,
  permission: PERMISSIONS.creditNoteIssue,
  // A human must click "Issue". The AI may prepare drafts, never issue them.
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const draft = await lockCreditNote(tx, companyId, input.creditNoteId, input.expectedVersion);
    const today = businessDate(now);
    if (draft.creditNoteDate > today) {
      throw new BusinessRuleError(
        'CREDIT_NOTE_DATE_IN_FUTURE',
        `Credit note date ${draft.creditNoteDate} is after today (${today})`,
      );
    }

    // Everything that settles the invoice serialises on this lock; amounts are read after it.
    const invoice = await loadCreditableInvoice(tx, companyId, draft.invoiceId, { lock: true });
    const requested = await tx
      .selectFrom('sales.creditNoteLines')
      .select(['invoiceLineNo', 'quantity', 'unitRate'])
      .where('creditNoteId', '=', draft.id)
      .orderBy('lineNo')
      .execute();
    const priced = assessOrThrow(invoice, {
      customerId: draft.customerId,
      creditNoteDate: draft.creditNoteDate,
      lines: requested,
    });
    const recalculated = priced.calc.totals.grandTotal !== draft.grandTotal;
    await replaceCreditNoteLines(tx, draft.id, draft.invoiceId, priced.lines);

    const { company, snapshot: seller } = await loadSeller(tx, companyId);
    const { snapshot: customer } = await loadInvoiceableCustomer(tx, companyId, draft.customerId);
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'CREDIT_NOTE',
      prefix: company.creditNotePrefix,
      documentDate: draft.creditNoteDate,
      now,
    });

    await tx
      .updateTable('sales.creditNotes')
      .set({
        ...totalsColumns(priced.calc),
        status: 'ISSUED',
        creditNoteNumber: documentNumber,
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

    const grandTotal = priced.calc.totals.grandTotal;
    await postCreditNoteToLedger(tx, {
      companyId,
      customerId: draft.customerId,
      creditNoteId: draft.id,
      creditNoteNumber: documentNumber,
      invoiceNumber: invoice.invoiceNumber ?? '',
      creditNoteDate: draft.creditNoteDate,
      grandTotal,
      userId: actor.user.id,
      now,
    });

    const outstandingBefore = outstandingOf(
      invoice.grandTotal,
      invoice.paidAmount,
      invoice.creditedAmount,
    );
    const creditNote = await loadCreditNoteDto(tx, companyId, draft.id);
    return {
      result: creditNote,
      audit: [
        {
          entityType: 'sales.credit_note',
          entityId: draft.id,
          before: { status: 'DRAFT', version: draft.version, grandTotal: draft.grandTotal },
          after: {
            status: 'ISSUED',
            version: creditNote.version,
            creditNoteNumber: documentNumber,
            fiscalYear,
            invoiceNumber: invoice.invoiceNumber,
            grandTotal,
            calcEngineVersion: creditNote.calcEngineVersion,
          },
          metadata: recalculated
            ? { recalculatedAtIssue: true, draftGrandTotal: draft.grandTotal }
            : undefined,
        },
        {
          entityType: 'sales.invoice',
          entityId: invoice.id,
          before: { outstandingAmount: outstandingBefore },
          after: {
            outstandingAmount: Money.of(outstandingBefore).minus(Money.of(grandTotal)).toString(),
            creditedAmount: grandTotal,
            creditNoteNumber: documentNumber,
          },
        },
      ],
      outbox: [
        {
          topic: CREDIT_NOTE_ISSUED_TOPIC,
          aggregateType: 'sales.credit_note',
          aggregateId: draft.id,
          payload: { creditNoteId: draft.id, companyId },
        },
      ],
    };
  },
});

import {
  CreateInvoiceDraftRequest,
  DeleteInvoiceDraftRequest,
  PERMISSIONS,
  UpdateInvoiceDraftRequest,
  type InvoiceDto,
} from '@factory-erp/contracts';
import type { DbTransaction } from '../../db/database';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { loadInvoiceDto } from './invoice-dto';
import { replaceInvoiceLines, totalsColumns } from './invoice-store';
import { policyFromCompany, priceInvoice, type DraftLine } from './pricing';
import { loadInvoiceableCustomer, loadSeller } from './snapshots';

interface DraftInput {
  customerId: string;
  invoiceDate: string;
  placeOfSupplyStateCode?: string | undefined;
  notes: string | null;
  lines: DraftLine[];
}

async function priceDraft(tx: DbTransaction, companyId: string, input: DraftInput) {
  const { company } = await loadSeller(tx, companyId);
  const { party } = await loadInvoiceableCustomer(tx, companyId, input.customerId);
  // [VERIFY R-05] Place of supply defaults to the customer's state; overrides are allowed
  // for drafts but SEZ/export/bill-to-ship-to rules are not modelled yet.
  const placeOfSupply = input.placeOfSupplyStateCode ?? party.stateCode;
  const pos = await tx
    .selectFrom('platform.states')
    .select('code')
    .where('code', '=', placeOfSupply)
    .executeTakeFirst();
  if (!pos)
    throw new BusinessRuleError('UNKNOWN_STATE', `Unknown place-of-supply state ${placeOfSupply}`);

  const priced = await priceInvoice(tx, {
    companyId,
    invoiceDate: input.invoiceDate,
    supplierStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    policy: policyFromCompany(company.invoiceRounding),
    lines: input.lines,
  });
  return { ...priced, supplierStateCode: company.stateCode, placeOfSupply };
}

export const createInvoiceDraft = defineCommand({
  name: 'sales.invoice.createDraft',
  description: 'Create a draft sales invoice. Totals and GST are computed by the server.',
  input: CreateInvoiceDraftRequest,
  permission: PERMISSIONS.salesInvoiceDraft,
  ai: { tier: 'DRAFT' },
  examples: [
    {
      description: 'Draft an invoice for 400 units of one item (a human issues it)',
      input: {
        customerId: '01900000-0000-7000-8000-000000000001',
        invoiceDate: '2026-10-07',
        lines: [
          { itemId: '01900000-0000-7000-8000-000000000002', quantity: '400', unitRate: '245' },
        ],
      },
    },
  ],
  handler: async ({ tx, actor, companyId, now }, input) => {
    const priced = await priceDraft(tx, companyId, input);
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('sales.invoices')
      .values({
        id,
        companyId,
        status: 'DRAFT',
        invoiceDate: input.invoiceDate,
        customerId: input.customerId,
        supplierStateCode: priced.supplierStateCode,
        placeOfSupplyStateCode: priced.placeOfSupply,
        notes: input.notes,
        ...totalsColumns(priced.calc),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();
    await replaceInvoiceLines(tx, id, priced.lines);

    const invoice: InvoiceDto = await loadInvoiceDto(tx, companyId, id);
    return {
      result: invoice,
      audit: [
        {
          entityType: 'sales.invoice',
          entityId: id,
          after: {
            status: 'DRAFT',
            customerId: input.customerId,
            invoiceDate: input.invoiceDate,
            grandTotal: invoice.grandTotal,
            lineCount: invoice.lines.length,
          },
        },
      ],
    };
  },
});

async function lockDraft(
  tx: DbTransaction,
  companyId: string,
  invoiceId: string,
  expectedVersion: number,
) {
  const inv = await tx
    .selectFrom('sales.invoices')
    .select(['id', 'status', 'version', 'grandTotal', 'customerId', 'invoiceDate'])
    .where('companyId', '=', companyId)
    .where('id', '=', invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!inv) throw new NotFoundError('Invoice');
  if (inv.status !== 'DRAFT')
    throw new BusinessRuleError(
      'INVOICE_NOT_DRAFT',
      `Only draft invoices can be changed (this one is ${inv.status})`,
    );
  if (inv.version !== expectedVersion) throw new VersionConflictError('Invoice');
  return inv;
}

export const updateInvoiceDraft = defineCommand({
  name: 'sales.invoice.updateDraft',
  description:
    'Replace the content of a draft sales invoice (optimistic concurrency via expectedVersion).',
  input: UpdateInvoiceDraftRequest,
  permission: PERMISSIONS.salesInvoiceDraft,
  ai: { tier: 'DRAFT' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockDraft(tx, companyId, input.invoiceId, input.expectedVersion);
    const priced = await priceDraft(tx, companyId, input);
    await tx
      .updateTable('sales.invoices')
      .set({
        invoiceDate: input.invoiceDate,
        customerId: input.customerId,
        supplierStateCode: priced.supplierStateCode,
        placeOfSupplyStateCode: priced.placeOfSupply,
        notes: input.notes,
        ...totalsColumns(priced.calc),
        version: before.version + 1,
        updatedBy: actor.user.id,
        updatedAt: now,
      })
      .where('id', '=', input.invoiceId)
      .execute();
    await replaceInvoiceLines(tx, input.invoiceId, priced.lines);

    const invoice = await loadInvoiceDto(tx, companyId, input.invoiceId);
    return {
      result: invoice,
      audit: [
        {
          entityType: 'sales.invoice',
          entityId: input.invoiceId,
          before: {
            version: before.version,
            customerId: before.customerId,
            invoiceDate: before.invoiceDate,
            grandTotal: before.grandTotal,
          },
          after: {
            version: invoice.version,
            customerId: invoice.customerId,
            invoiceDate: invoice.invoiceDate,
            grandTotal: invoice.grandTotal,
          },
        },
      ],
    };
  },
});

export const deleteInvoiceDraft = defineCommand({
  name: 'sales.invoice.deleteDraft',
  description: 'Delete a draft sales invoice. Issued invoices can never be deleted.',
  input: DeleteInvoiceDraftRequest,
  permission: PERMISSIONS.salesInvoiceDraft,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, companyId }, input) => {
    const before = await lockDraft(tx, companyId, input.invoiceId, input.expectedVersion);
    await tx.deleteFrom('sales.invoices').where('id', '=', input.invoiceId).execute();
    return {
      result: { deleted: true as const, invoiceId: input.invoiceId },
      audit: [{ entityType: 'sales.invoice', entityId: input.invoiceId, before }],
    };
  },
});

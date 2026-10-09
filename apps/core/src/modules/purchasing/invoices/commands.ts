import {
  CreatePurchaseInvoiceRequest,
  PERMISSIONS,
  PostPurchaseInvoiceRequest,
  PurchaseInvoiceVersionRequest,
  UpdatePurchaseInvoiceRequest,
  type PurchaseInvoiceDto,
} from '@factory-erp/contracts';
import { financialYearOf } from '@factory-erp/gst';
import type { z } from 'zod';
import type { DbTransaction } from '../../../db/database';
import { addDays, businessDate } from '../../../platform/clock';
import { defineCommand } from '../../../platform/commands';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../../../platform/errors';
import { uuidv7 } from '../../../platform/ids';
import { toJsonb } from '../../../platform/json';
import { allocateDocumentNumber } from '../../../platform/numbering';
import { postPurchaseInvoicePayable } from '../../finance';
import { orderTotals } from '../orders/store';
import { loadBuyer, loadSupplier, pricePurchase, supplierSnapshot } from '../supplier';
import { loadPurchaseInvoiceDto } from './dto';
import { evaluateMatch, matchStatusOf, tolerancesOf } from './evaluate';
import { replaceInvoiceLines, supplierInvoiceKey, type InvoicePricedLine } from './store';

type InvoiceBody = z.output<typeof CreatePurchaseInvoiceRequest>;

/** Orders a supplier bill may be entered against: approved, receiving, received or short-closed. */
const BILLABLE_ORDER_STATUSES = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

async function checkOrderReference(
  tx: DbTransaction,
  companyId: string,
  body: Pick<InvoiceBody, 'supplierId' | 'orderId' | 'goodsReceiptId' | 'lines'>,
  opts: { lock: boolean },
) {
  if (!body.orderId) return;
  let q = tx
    .selectFrom('purchase.orders')
    .select(['id', 'status', 'poNumber', 'supplierId'])
    .where('companyId', '=', companyId)
    .where('id', '=', body.orderId);
  if (opts.lock) q = q.forUpdate();
  const order = await q.executeTakeFirst();
  if (!order) throw new NotFoundError('Purchase order');
  if (order.supplierId !== body.supplierId) {
    throw new BusinessRuleError(
      'ORDER_SUPPLIER_MISMATCH',
      `Purchase order ${order.poNumber ?? '(draft)'} was placed with a different supplier`,
    );
  }
  if (!BILLABLE_ORDER_STATUSES.includes(order.status)) {
    throw new BusinessRuleError(
      'PURCHASE_ORDER_NOT_BILLABLE',
      `Purchase order ${order.poNumber ?? '(draft)'} is ${order.status}; bills can only be entered against an approved order`,
    );
  }
  const orderLines = await tx
    .selectFrom('purchase.orderLines')
    .select('lineNo')
    .where('orderId', '=', order.id)
    .execute();
  const known = new Set(orderLines.map((l) => l.lineNo));
  const issues = body.lines.flatMap((l, i) =>
    l.orderLineNo !== null && !known.has(l.orderLineNo)
      ? [
          {
            path: `lines.${i}.orderLineNo`,
            message: `Order ${order.poNumber ?? ''} has no line ${l.orderLineNo}`,
          },
        ]
      : [],
  );
  if (body.goodsReceiptId) {
    const grn = await tx
      .selectFrom('purchase.goodsReceipts')
      .select('id')
      .where('companyId', '=', companyId)
      .where('id', '=', body.goodsReceiptId)
      .where('orderId', '=', order.id)
      .executeTakeFirst();
    if (!grn) {
      issues.push({
        path: 'goodsReceiptId',
        message: 'That goods receipt is not a delivery against this order',
      });
    }
  }
  if (issues.length) throw new ValidationError(issues, 'The bill does not fit its order');
}

async function assertNotDuplicate(
  tx: DbTransaction,
  companyId: string,
  body: Pick<InvoiceBody, 'supplierId' | 'supplierInvoiceNumber' | 'invoiceDate'>,
  selfId: string | null,
) {
  let q = tx
    .selectFrom('purchase.invoices')
    .select(['id', 'invoiceNumber', 'status'])
    .where('companyId', '=', companyId)
    .where('supplierId', '=', body.supplierId)
    .where('supplierFiscalYear', '=', financialYearOf(body.invoiceDate).label)
    .where('supplierInvoiceKey', '=', supplierInvoiceKey(body.supplierInvoiceNumber));
  if (selfId) q = q.where('id', '<>', selfId);
  const existing = await q.executeTakeFirst();
  if (existing) {
    throw new BusinessRuleError(
      'DUPLICATE_SUPPLIER_INVOICE',
      `Supplier bill ${body.supplierInvoiceNumber} is already entered${existing.invoiceNumber ? ` as ${existing.invoiceNumber}` : ' (draft)'}`,
    );
  }
}

function assertNotFutureDated(invoiceDate: string, now: Date) {
  const today = businessDate(now);
  if (invoiceDate > today) {
    throw new BusinessRuleError(
      'INVOICE_DATE_IN_FUTURE',
      `Invoice date ${invoiceDate} is after today (${today})`,
    );
  }
}

/** Price the bill with the shared GST engine at the billed rates, in force on the bill date. */
async function priceInvoice(tx: DbTransaction, companyId: string, body: InvoiceBody) {
  const buyer = await loadBuyer(tx, companyId);
  const supplier = await loadSupplier(tx, companyId, body.supplierId);
  const priced = await pricePurchase(tx, {
    companyId,
    documentDate: body.invoiceDate,
    supplierStateCode: supplier.stateCode,
    buyerStateCode: buyer.stateCode,
    invoiceRounding: buyer.invoiceRounding,
    lines: body.lines,
  });
  const lines: InvoicePricedLine[] = priced.lines.map((l, i) => ({
    ...l,
    orderLineNo: body.lines[i]?.orderLineNo ?? null,
  }));
  return {
    calc: priced.calc,
    lines,
    buyer,
    supplier,
    // Payment terms from the supplier master [CA validation point: MSME 45-day rule, VERIFY R-18].
    dueDate: addDays(body.invoiceDate, supplier.creditDays ?? 0),
  };
}

const headerOf = (body: InvoiceBody, priced: Awaited<ReturnType<typeof priceInvoice>>) => ({
  supplierId: body.supplierId,
  orderId: body.orderId,
  goodsReceiptId: body.goodsReceiptId,
  supplierInvoiceNumber: body.supplierInvoiceNumber,
  supplierInvoiceKey: supplierInvoiceKey(body.supplierInvoiceNumber),
  invoiceDate: body.invoiceDate,
  supplierFiscalYear: financialYearOf(body.invoiceDate).label,
  dueDate: priced.dueDate,
  supplierStateCode: priced.supplier.stateCode,
  placeOfSupplyStateCode: priced.buyer.stateCode,
  supplierStatedTotal: body.supplierStatedTotal,
  notes: body.notes,
  ...orderTotals(priced.calc),
});

const auditSummary = (i: PurchaseInvoiceDto) => ({
  status: i.status,
  invoiceNumber: i.invoiceNumber,
  supplierId: i.supplierId,
  supplierInvoiceNumber: i.supplierInvoiceNumber,
  invoiceDate: i.invoiceDate,
  orderId: i.orderId,
  grandTotal: i.grandTotal,
  supplierStatedTotal: i.supplierStatedTotal,
  matchStatus: i.matchStatus,
  lineCount: i.lines.length,
  version: i.version,
});

export const createPurchaseInvoiceDraft = defineCommand({
  name: 'purchase.invoice.createDraft',
  description:
    "Enter a supplier's bill as a draft, against a purchase order or directly. Tax is computed by the server; a human posts it.",
  input: CreatePurchaseInvoiceRequest,
  permission: PERMISSIONS.purchaseInvoiceDraft,
  ai: { tier: 'DRAFT' },
  examples: [
    {
      description: 'Enter a supplier bill for 500 kg delivered against a purchase order',
      input: {
        supplierId: '01900000-0000-7000-8000-000000000003',
        orderId: '01900000-0000-7000-8000-000000000006',
        supplierInvoiceNumber: 'DMT/2026/1187',
        invoiceDate: '2026-10-08',
        supplierStatedTotal: '40414.00',
        lines: [
          {
            itemId: '01900000-0000-7000-8000-000000000005',
            orderLineNo: 1,
            quantity: '500',
            unitRate: '68.50',
          },
        ],
      },
    },
  ],
  handler: async ({ tx, actor, companyId, now }, input) => {
    assertNotFutureDated(input.invoiceDate, now);
    await checkOrderReference(tx, companyId, input, { lock: false });
    await assertNotDuplicate(tx, companyId, input, null);
    const priced = await priceInvoice(tx, companyId, input);
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('purchase.invoices')
      .values({
        id,
        companyId,
        status: 'DRAFT',
        ...headerOf(input, priced),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();
    await replaceInvoiceLines(tx, id, input.orderId, priced.lines);
    const invoice = await loadPurchaseInvoiceDto(tx, companyId, id, businessDate(now));
    return {
      result: invoice,
      audit: [{ entityType: 'purchase.invoice', entityId: id, after: auditSummary(invoice) }],
    };
  },
});

async function lockInvoice(
  tx: DbTransaction,
  companyId: string,
  invoiceId: string,
  expectedVersion: number,
) {
  const inv = await tx
    .selectFrom('purchase.invoices')
    .selectAll()
    .where('companyId', '=', companyId)
    .where('id', '=', invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!inv) throw new NotFoundError('Purchase invoice');
  if (inv.version !== expectedVersion) throw new VersionConflictError('Purchase invoice');
  if (inv.status !== 'DRAFT') {
    throw new BusinessRuleError(
      'PURCHASE_INVOICE_POSTED',
      `Purchase invoice ${inv.invoiceNumber ?? ''} is posted; it cannot be changed`,
    );
  }
  return inv;
}

export const updatePurchaseInvoiceDraft = defineCommand({
  name: 'purchase.invoice.updateDraft',
  description: 'Replace the content of a draft supplier bill (optimistic concurrency).',
  input: UpdatePurchaseInvoiceRequest,
  permission: PERMISSIONS.purchaseInvoiceDraft,
  ai: { tier: 'DRAFT' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockInvoice(tx, companyId, input.invoiceId, input.expectedVersion);
    assertNotFutureDated(input.invoiceDate, now);
    await checkOrderReference(tx, companyId, input, { lock: false });
    await assertNotDuplicate(tx, companyId, input, before.id);
    const priced = await priceInvoice(tx, companyId, input);
    await tx
      .updateTable('purchase.invoices')
      .set({
        ...headerOf(input, priced),
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();
    await replaceInvoiceLines(tx, before.id, input.orderId, priced.lines);
    const invoice = await loadPurchaseInvoiceDto(tx, companyId, before.id, businessDate(now));
    return {
      result: invoice,
      audit: [
        {
          entityType: 'purchase.invoice',
          entityId: before.id,
          before: {
            grandTotal: before.grandTotal,
            supplierInvoiceNumber: before.supplierInvoiceNumber,
            version: before.version,
          },
          after: auditSummary(invoice),
        },
      ],
    };
  },
});

export const deletePurchaseInvoiceDraft = defineCommand({
  name: 'purchase.invoice.deleteDraft',
  description: 'Delete a draft supplier bill (posted bills are permanent).',
  input: PurchaseInvoiceVersionRequest,
  permission: PERMISSIONS.purchaseInvoiceDraft,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, companyId }, input) => {
    const before = await lockInvoice(tx, companyId, input.invoiceId, input.expectedVersion);
    await tx.deleteFrom('purchase.invoices').where('id', '=', before.id).execute();
    return {
      result: { deleted: true as const },
      audit: [
        {
          entityType: 'purchase.invoice',
          entityId: before.id,
          before: {
            status: 'DRAFT',
            supplierInvoiceNumber: before.supplierInvoiceNumber,
            grandTotal: before.grandTotal,
          },
          after: { deleted: true },
        },
      ],
    };
  },
});

/**
 * Post a supplier bill — one transaction:
 *   lock the bill (and its order, so receipts cannot change underneath) → reprice from master
 *   data → three-way match → refuse on differences unless overridden with a reason by someone
 *   allowed to → number it by posting date → freeze it → credit the supplier's payable → audit.
 */
export const postPurchaseInvoice = defineCommand({
  name: 'purchase.invoice.post',
  description:
    'Post a draft supplier bill after the three-way match: it is numbered, frozen and becomes owed to the supplier.',
  input: PostPurchaseInvoiceRequest,
  permission: PERMISSIONS.purchaseInvoicePost,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockInvoice(tx, companyId, input.invoiceId, input.expectedVersion);
    assertNotFutureDated(before.invoiceDate, now);
    const stored = await tx
      .selectFrom('purchase.invoiceLines')
      .select(['itemId', 'description', 'quantity', 'unitRate', 'discountPercent', 'orderLineNo'])
      .where('invoiceId', '=', before.id)
      .orderBy('lineNo')
      .execute();
    const body: InvoiceBody = {
      supplierId: before.supplierId,
      orderId: before.orderId,
      goodsReceiptId: before.goodsReceiptId,
      supplierInvoiceNumber: before.supplierInvoiceNumber,
      invoiceDate: before.invoiceDate,
      supplierStatedTotal: before.supplierStatedTotal,
      notes: before.notes,
      lines: stored,
    };
    await checkOrderReference(tx, companyId, body, { lock: true });
    const priced = await priceInvoice(tx, companyId, body);
    await replaceInvoiceLines(tx, before.id, before.orderId, priced.lines);

    const findings = await evaluateMatch(
      tx,
      {
        companyId,
        orderId: before.orderId,
        lines: priced.lines,
        computedTotal: priced.calc.totals.grandTotal,
        supplierStatedTotal: before.supplierStatedTotal,
      },
      tolerancesOf(priced.buyer),
    );
    if (findings.length > 0) {
      if (!input.matchOverrideReason) {
        throw new BusinessRuleError(
          'THREE_WAY_MATCH_FAILED',
          `The bill does not match: ${findings.map((f) => f.message).join('; ')}`,
          findings.map((f) => ({
            path: f.invoiceLineNo === null ? 'supplierStatedTotal' : `lines.${f.invoiceLineNo - 1}`,
            message: f.message,
          })),
        );
      }
      if (!actor.user.permissions.has(PERMISSIONS.purchaseInvoiceOverrideMatch)) {
        throw new ForbiddenError(PERMISSIONS.purchaseInvoiceOverrideMatch);
      }
      if (input.matchOverrideReason.length < 3) {
        throw new ValidationError([
          { path: 'matchOverrideReason', message: 'Give a reason (at least 3 characters)' },
        ]);
      }
    }

    const postingDate = businessDate(now);
    const { documentNumber, fiscalYear } = await allocateDocumentNumber(tx, {
      companyId,
      docType: 'PURCHASE_INVOICE',
      prefix: priced.buyer.purchaseInvoicePrefix,
      documentDate: postingDate,
      now,
    });
    await tx
      .updateTable('purchase.invoices')
      .set({
        ...headerOf(body, priced),
        status: 'POSTED',
        invoiceNumber: documentNumber,
        fiscalYear,
        postingDate,
        matchStatus: matchStatusOf(before.orderId, findings),
        matchFindings: toJsonb(findings),
        matchOverrideReason: findings.length > 0 ? input.matchOverrideReason : null,
        supplierSnapshot: toJsonb(supplierSnapshot(priced.supplier)),
        postedAt: now,
        postedBy: actor.user.id,
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();

    await postPurchaseInvoicePayable(tx, {
      companyId,
      supplierId: before.supplierId,
      purchaseInvoiceId: before.id,
      invoiceNumber: documentNumber,
      supplierInvoiceNumber: before.supplierInvoiceNumber,
      invoiceDate: before.invoiceDate,
      grandTotal: priced.calc.totals.grandTotal,
      userId: actor.user.id,
      now,
    });

    const invoice = await loadPurchaseInvoiceDto(tx, companyId, before.id, postingDate);
    return {
      result: invoice,
      audit: [
        {
          entityType: 'purchase.invoice',
          entityId: before.id,
          before: { status: 'DRAFT', grandTotal: before.grandTotal, version: before.version },
          after: {
            ...auditSummary(invoice),
            matchFindings: findings.map((f) => f.code),
            matchOverrideReason: invoice.matchOverrideReason,
          },
        },
      ],
    };
  },
});

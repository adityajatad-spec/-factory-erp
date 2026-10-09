import type {
  MatchFinding,
  MatchStatus,
  PurchaseInvoiceDto,
  PurchaseInvoiceListItemDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';
import { outstandingOfPurchase, payableStatusOf, purchasePaidSql } from './settlement';

export function selectPurchaseInvoices(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('purchase.invoices as pi')
    .innerJoin('party.parties as p', 'p.id', 'pi.supplierId')
    .leftJoin('purchase.orders as o', 'o.id', 'pi.orderId')
    .select([
      'pi.id',
      'pi.status',
      'pi.invoiceNumber',
      'pi.postingDate',
      'pi.supplierInvoiceNumber',
      'pi.invoiceDate',
      'pi.dueDate',
      'pi.supplierId',
      'p.name as supplierName',
      'pi.orderId',
      'o.poNumber',
      'pi.grandTotal',
      'pi.matchStatus',
    ])
    .select(purchasePaidSql.as('paidAmount'))
    .where('pi.companyId', '=', companyId);
}

type ListRow = Awaited<ReturnType<ReturnType<typeof selectPurchaseInvoices>['execute']>>[number];

export function toPurchaseInvoiceListItem(r: ListRow, today: string): PurchaseInvoiceListItemDto {
  const posted = r.status === 'POSTED';
  const outstanding = posted ? outstandingOfPurchase(r.grandTotal, r.paidAmount) : '0.00';
  return {
    id: r.id,
    status: posted ? 'POSTED' : 'DRAFT',
    invoiceNumber: r.invoiceNumber,
    postingDate: r.postingDate,
    supplierInvoiceNumber: r.supplierInvoiceNumber,
    invoiceDate: r.invoiceDate,
    dueDate: r.dueDate,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    orderId: r.orderId,
    poNumber: r.poNumber,
    grandTotal: r.grandTotal,
    matchStatus: r.matchStatus as MatchStatus | null,
    paidAmount: r.paidAmount,
    outstandingAmount: outstanding,
    payableStatus: payableStatusOf(r.status, r.grandTotal, r.paidAmount),
    isOverdue: posted && Money.of(outstanding).isPositive() && r.dueDate < today,
  };
}

export async function loadPurchaseInvoiceDto(
  db: DbExecutor,
  companyId: string,
  invoiceId: string,
  today: string,
): Promise<PurchaseInvoiceDto> {
  const row = await selectPurchaseInvoices(db, companyId)
    .leftJoin('purchase.goodsReceipts as g', 'g.id', 'pi.goodsReceiptId')
    .leftJoin('identity.users as up', 'up.id', 'pi.postedBy')
    .select([
      'p.code as supplierCode',
      'p.gstin as supplierGstin',
      'pi.goodsReceiptId',
      'g.grnNumber',
      'pi.supplyType',
      'pi.notes',
      'pi.grossAmount',
      'pi.discountAmount',
      'pi.taxableAmount',
      'pi.cgstAmount',
      'pi.sgstAmount',
      'pi.igstAmount',
      'pi.totalTax',
      'pi.roundOff',
      'pi.amountInWords',
      'pi.supplierStatedTotal',
      'pi.matchFindings',
      'pi.matchOverrideReason',
      'pi.postedAt',
      'up.displayName as postedByName',
      'pi.version',
    ])
    .where('pi.id', '=', invoiceId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Purchase invoice');

  const lines = await db
    .selectFrom('purchase.invoiceLines as l')
    .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
    .select([
      'l.lineNo',
      'l.itemId',
      'i.code as itemCode',
      'l.description',
      'l.hsnCode',
      'l.uom',
      'l.quantity',
      'l.unitRate',
      'l.discountPercent',
      'l.gstRatePercent',
      'l.taxableAmount',
      'l.cgstAmount',
      'l.sgstAmount',
      'l.igstAmount',
      'l.lineTotal',
      'l.orderLineNo',
    ])
    .where('l.invoiceId', '=', invoiceId)
    .orderBy('l.lineNo')
    .execute();

  const payments = await db
    .selectFrom('finance.supplierPaymentAllocations as a')
    .innerJoin('finance.supplierPayments as sp', 'sp.id', 'a.paymentId')
    .select(['sp.id as paymentId', 'sp.paymentNumber', 'sp.paymentDate', 'a.amount'])
    .where('a.purchaseInvoiceId', '=', invoiceId)
    .orderBy('sp.paymentDate')
    .orderBy('a.allocatedAt')
    .execute();

  return {
    ...toPurchaseInvoiceListItem(row, today),
    basis: row.orderId ? 'PURCHASE_ORDER' : 'DIRECT',
    supplierCode: row.supplierCode,
    supplierGstin: row.supplierGstin,
    goodsReceiptId: row.goodsReceiptId,
    grnNumber: row.grnNumber,
    supplyType: row.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    notes: row.notes,
    grossAmount: row.grossAmount,
    discountAmount: row.discountAmount,
    taxableAmount: row.taxableAmount,
    cgstAmount: row.cgstAmount,
    sgstAmount: row.sgstAmount,
    igstAmount: row.igstAmount,
    totalTax: row.totalTax,
    roundOff: row.roundOff,
    amountInWords: row.amountInWords,
    supplierStatedTotal: row.supplierStatedTotal,
    matchFindings: row.matchFindings as unknown as MatchFinding[],
    matchOverrideReason: row.matchOverrideReason,
    lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    postedByName: row.postedByName,
    payments,
    version: row.version,
  };
}

import type {
  PurchaseOrderDto,
  PurchaseOrderListItemDto,
  PurchaseOrderStatus,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';

const OPEN: readonly PurchaseOrderStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];

/** Open (still expecting goods) and past its expected delivery date. */
export const isOverdue = (status: string, expectedDate: string | null, today: string) =>
  (OPEN as readonly string[]).includes(status) && expectedDate !== null && expectedDate < today;

export function selectOrderList(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('purchase.orders as o')
    .innerJoin('party.parties as p', 'p.id', 'o.supplierId')
    .innerJoin('inventory.warehouses as w', 'w.id', 'o.warehouseId')
    .select([
      'o.id',
      'o.status',
      'o.poNumber',
      'o.poDate',
      'o.expectedDate',
      'o.supplierId',
      'p.name as supplierName',
      'w.code as warehouseCode',
      'o.grandTotal',
    ])
    .where('o.companyId', '=', companyId);
}

type ListRow = Awaited<ReturnType<ReturnType<typeof selectOrderList>['execute']>>[number];

export function toOrderListItem(r: ListRow, today: string): PurchaseOrderListItemDto {
  return {
    ...r,
    status: r.status as PurchaseOrderStatus,
    isOverdue: isOverdue(r.status, r.expectedDate, today),
  };
}

export async function loadOrderDto(
  db: DbExecutor,
  companyId: string,
  orderId: string,
  today: string,
): Promise<PurchaseOrderDto> {
  const o = await db
    .selectFrom('purchase.orders as o')
    .innerJoin('party.parties as p', 'p.id', 'o.supplierId')
    .innerJoin('inventory.warehouses as w', 'w.id', 'o.warehouseId')
    .leftJoin('identity.users as ua', 'ua.id', 'o.approvedBy')
    .selectAll('o')
    .select([
      'p.name as supplierName',
      'p.code as supplierCode',
      'p.gstin as supplierGstin',
      'w.code as warehouseCode',
      'w.name as warehouseName',
      'ua.displayName as approvedByName',
    ])
    .where('o.companyId', '=', companyId)
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o) throw new NotFoundError('Purchase order');

  const lines = await db
    .selectFrom('purchase.orderLines as l')
    .innerJoin('catalog.items as i', 'i.id', 'l.itemId')
    .innerJoin('purchase.orderLineProgress as g', (j) =>
      j.onRef('g.orderId', '=', 'l.orderId').onRef('g.lineNo', '=', 'l.lineNo'),
    )
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
      sql<string>`g.accepted_quantity::text`.as('acceptedQuantity'),
      sql<string>`g.rejected_quantity::text`.as('rejectedQuantity'),
      sql<string>`g.remaining_quantity::text`.as('remainingQuantity'),
      sql<string>`g.invoiced_quantity::text`.as('invoicedQuantity'),
    ])
    .where('l.orderId', '=', orderId)
    .orderBy('l.lineNo')
    .execute();

  const receipts = await db
    .selectFrom('purchase.goodsReceipts')
    .select(['id', 'grnNumber', 'receiptDate'])
    .where('orderId', '=', orderId)
    .orderBy('grnNumber')
    .execute();

  const invoices = await db
    .selectFrom('purchase.invoices')
    .select(['id', 'invoiceNumber', 'supplierInvoiceNumber', 'status'])
    .where('orderId', '=', orderId)
    .orderBy('invoiceDate')
    .orderBy('createdAt')
    .execute();

  return {
    id: o.id,
    status: o.status as PurchaseOrderStatus,
    poNumber: o.poNumber,
    poDate: o.poDate,
    expectedDate: o.expectedDate,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    supplierCode: o.supplierCode,
    supplierGstin: o.supplierGstin,
    warehouseId: o.warehouseId,
    warehouseCode: o.warehouseCode,
    warehouseName: o.warehouseName,
    supplyType: o.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    notes: o.notes,
    grossAmount: o.grossAmount,
    discountAmount: o.discountAmount,
    taxableAmount: o.taxableAmount,
    cgstAmount: o.cgstAmount,
    sgstAmount: o.sgstAmount,
    igstAmount: o.igstAmount,
    totalTax: o.totalTax,
    roundOff: o.roundOff,
    grandTotal: o.grandTotal,
    amountInWords: o.amountInWords,
    lines,
    approvedAt: o.approvedAt?.toISOString() ?? null,
    approvedByName: o.approvedByName,
    closedAt: o.closedAt?.toISOString() ?? null,
    closeReason: o.closeReason,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    pdfDocumentId: o.pdfDocumentId,
    receipts,
    invoices,
    isOverdue: isOverdue(o.status, o.expectedDate, today),
    version: o.version,
  };
}

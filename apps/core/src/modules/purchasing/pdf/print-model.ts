import { z } from 'zod';
import type { DbExecutor } from '../../../db/database';
import { NotFoundError } from '../../../platform/errors';
import { normalisePercent } from '../../catalog';

/** The supplier as frozen on the order when it was approved (see supplierSnapshot). */
const SupplierOnOrder = z.object({
  code: z.string(),
  name: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
});

export interface PurchaseOrderPrintModel {
  buyer: {
    legalName: string;
    gstin: string | null;
    stateName: string;
    addressLines: string[];
    contact: string[];
    isDemo: boolean;
  };
  supplier: {
    code: string;
    name: string;
    gstin: string | null;
    addressLines: string[];
    stateCode: string;
  };
  deliverTo: { warehouse: string };
  poNumber: string;
  poDate: string;
  expectedDate: string | null;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  lines: Array<{
    lineNo: number;
    description: string;
    hsnCode: string;
    quantity: string;
    uom: string;
    unitRate: string;
    discountPercent: string;
    gstRatePercent: string;
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    lineTotal: string;
  }>;
  totals: {
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    roundOff: string;
    grandTotal: string;
  };
  amountInWords: string;
  notes: string | null;
  approvedByName: string | null;
  engineVersion: string;
  /** True until the company's finance readiness is PRODUCTION. */
  specimen: boolean;
}

const lines = (...parts: Array<string | null | undefined>) =>
  parts.filter((p): p is string => !!p && p.trim() !== '');

/** Build the print model from the APPROVED order's stored values and supplier snapshot. */
export async function buildPurchaseOrderPrintModel(
  db: DbExecutor,
  orderId: string,
): Promise<PurchaseOrderPrintModel> {
  const o = await db
    .selectFrom('purchase.orders as o')
    .innerJoin('platform.companies as c', 'c.id', 'o.companyId')
    .innerJoin('platform.states as s', 's.code', 'c.stateCode')
    .innerJoin('inventory.warehouses as w', 'w.id', 'o.warehouseId')
    .leftJoin('identity.users as u', 'u.id', 'o.approvedBy')
    .selectAll('o')
    .select([
      'c.legalName',
      'c.gstin as buyerGstin',
      'c.addressLine1 as buyerAddress1',
      'c.addressLine2 as buyerAddress2',
      'c.city as buyerCity',
      'c.postalCode as buyerPostalCode',
      'c.phone as buyerPhone',
      'c.email as buyerEmail',
      'c.isDemo',
      'c.financeReadiness',
      's.name as buyerStateName',
      'w.code as warehouseCode',
      'w.name as warehouseName',
      'u.displayName as approvedByName',
    ])
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o?.poNumber) throw new NotFoundError('Approved purchase order');
  const supplier = SupplierOnOrder.parse(o.supplierSnapshot);
  const stored = await db
    .selectFrom('purchase.orderLines')
    .selectAll()
    .where('orderId', '=', orderId)
    .orderBy('lineNo')
    .execute();

  return {
    buyer: {
      legalName: o.legalName,
      gstin: o.buyerGstin,
      stateName: o.buyerStateName,
      addressLines: lines(o.buyerAddress1, o.buyerAddress2, `${o.buyerCity} ${o.buyerPostalCode}`),
      contact: lines(o.buyerPhone, o.buyerEmail),
      isDemo: o.isDemo,
    },
    supplier: {
      code: supplier.code,
      name: supplier.name,
      gstin: supplier.gstin,
      stateCode: supplier.stateCode,
      addressLines: lines(
        supplier.addressLine1,
        supplier.addressLine2,
        [supplier.city, supplier.postalCode].filter(Boolean).join(' '),
      ),
    },
    deliverTo: { warehouse: `${o.warehouseName} (${o.warehouseCode})` },
    poNumber: o.poNumber,
    poDate: o.poDate,
    expectedDate: o.expectedDate,
    supplyType: o.supplyType === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
    lines: stored.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      uom: l.uom,
      unitRate: l.unitRate,
      discountPercent: normalisePercent(l.discountPercent),
      gstRatePercent: normalisePercent(l.gstRatePercent),
      taxableAmount: l.taxableAmount,
      cgstAmount: l.cgstAmount,
      sgstAmount: l.sgstAmount,
      igstAmount: l.igstAmount,
      lineTotal: l.lineTotal,
    })),
    totals: {
      taxableAmount: o.taxableAmount,
      cgstAmount: o.cgstAmount,
      sgstAmount: o.sgstAmount,
      igstAmount: o.igstAmount,
      roundOff: o.roundOff,
      grandTotal: o.grandTotal,
    },
    amountInWords: o.amountInWords,
    notes: o.notes,
    approvedByName: o.approvedByName,
    engineVersion: o.calcEngineVersion,
    specimen: o.financeReadiness !== 'PRODUCTION',
  };
}

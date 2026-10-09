import { ITEM_TYPES } from '@factory-erp/contracts';
import type { DbExecutor, DbTransaction } from '../../db/database';
import { BusinessRuleError, NotFoundError } from '../../platform/errors';
import { policyFromCompany, priceLines, type DraftLine } from '../catalog';

/** The buying company: its state decides intra- vs inter-state supply. */
export async function loadBuyer(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('platform.companies')
    .select([
      'id',
      'legalName',
      'stateCode',
      'invoiceRounding',
      'poPrefix',
      'grnPrefix',
      'purchaseInvoicePrefix',
      'matchQtyTolerancePercent',
      'matchPriceTolerancePercent',
      'matchTotalTolerance',
    ])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
}

/** An active party of this company that is a supplier. Reads the parties table (reads may cross modules). */
export async function loadSupplier(db: DbExecutor, companyId: string, supplierId: string) {
  const s = await db
    .selectFrom('party.parties')
    .select([
      'id',
      'code',
      'name',
      'gstin',
      'stateCode',
      'addressLine1',
      'addressLine2',
      'city',
      'postalCode',
      'status',
      'isSupplier',
      'creditDays',
    ])
    .where('companyId', '=', companyId)
    .where('id', '=', supplierId)
    .executeTakeFirst();
  if (!s) throw new NotFoundError('Supplier');
  if (s.status !== 'ACTIVE' || !s.isSupplier) {
    throw new BusinessRuleError('NOT_AN_ACTIVE_SUPPLIER', `${s.name} is not an active supplier`);
  }
  return s;
}

export type Supplier = Awaited<ReturnType<typeof loadSupplier>>;

/** What a purchase document records about its supplier, frozen when it is approved or posted. */
export function supplierSnapshot(s: Supplier) {
  return {
    code: s.code,
    name: s.name,
    gstin: s.gstin,
    stateCode: s.stateCode,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    postalCode: s.postalCode,
  };
}

/**
 * Price purchase lines through the shared pricing path and GST engine. Goods are delivered to
 * the buyer, so the place of supply is the buyer's state [VERIFY R-05]: a supplier in the same
 * state charges CGST + SGST, one in another state IGST. Any item type may be bought.
 */
export function pricePurchase(
  tx: DbTransaction,
  args: {
    companyId: string;
    documentDate: string;
    supplierStateCode: string;
    buyerStateCode: string;
    invoiceRounding: string;
    lines: readonly DraftLine[];
  },
) {
  return priceLines(tx, {
    companyId: args.companyId,
    documentDate: args.documentDate,
    supplierStateCode: args.supplierStateCode,
    placeOfSupplyStateCode: args.buyerStateCode,
    policy: policyFromCompany(args.invoiceRounding),
    lines: args.lines,
    allowedTypes: ITEM_TYPES,
    notAllowedMessage: (name) => `${name} cannot be bought`,
  });
}

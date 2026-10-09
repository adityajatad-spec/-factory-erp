import type { GstPolicy, InvoiceCalcResult } from '@factory-erp/gst';
import type { DbTransaction } from '../../db/database';
import { priceLines, SALEABLE_TYPES, type DraftLine, type PricedLine } from '../catalog';

export { policyFromCompany, type DraftLine, type PricedLine } from '../catalog';

/** Price sales invoice lines: the shared pricing path, restricted to saleable items. */
export function priceInvoice(
  tx: DbTransaction,
  args: {
    companyId: string;
    invoiceDate: string;
    supplierStateCode: string;
    placeOfSupplyStateCode: string;
    policy: GstPolicy;
    lines: readonly DraftLine[];
  },
): Promise<{ calc: InvoiceCalcResult; lines: PricedLine[] }> {
  const { invoiceDate, ...rest } = args;
  return priceLines(tx, {
    ...rest,
    documentDate: invoiceDate,
    allowedTypes: SALEABLE_TYPES,
    notAllowedMessage: (name) => `${name} is not a saleable item`,
  });
}

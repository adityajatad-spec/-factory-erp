import { financialYearOf } from '@factory-erp/gst';
import type { DbTransaction } from '../db/database';
import { BusinessRuleError } from './errors';
import { uuidv7 } from './ids';

export function formatDocumentNumber(
  prefix: string,
  fyShort: string,
  sequence: bigint,
  padWidth: number,
): string {
  return `${prefix}/${fyShort}/${sequence.toString().padStart(padWidth, '0')}`;
}

/**
 * Allocate the next number in a document series (invoices, receipts, …) inside the
 * issuing transaction.
 *
 * The series row is locked FOR UPDATE, so concurrent issues serialise and numbers are
 * gapless and consecutive: a rolled-back transaction also rolls back its increment.
 * Numbers are assigned at issue time only — drafts never consume a number.
 */
export async function allocateDocumentNumber(
  tx: DbTransaction,
  args: { companyId: string; docType: string; prefix: string; documentDate: string; now: Date },
): Promise<{ documentNumber: string; fiscalYear: string }> {
  const fy = financialYearOf(args.documentDate);

  await tx
    .insertInto('system.numberSeries')
    .values({
      id: uuidv7(args.now.getTime()),
      companyId: args.companyId,
      docType: args.docType,
      seriesCode: 'DEFAULT',
      fiscalYear: fy.label,
      prefix: args.prefix,
    })
    .onConflict((oc) =>
      oc.columns(['companyId', 'docType', 'seriesCode', 'fiscalYear']).doNothing(),
    )
    .execute();

  const series = await tx
    .selectFrom('system.numberSeries')
    .selectAll()
    .where('companyId', '=', args.companyId)
    .where('docType', '=', args.docType)
    .where('seriesCode', '=', 'DEFAULT')
    .where('fiscalYear', '=', fy.label)
    .forUpdate()
    .executeTakeFirstOrThrow();

  // Keep numbering consecutive in date order within the series.
  if (series.lastDocumentDate && args.documentDate < series.lastDocumentDate) {
    throw new BusinessRuleError(
      'DATE_BEFORE_LAST_ISSUED',
      `Date ${args.documentDate} is earlier than the last document already numbered in this series (${series.lastDocumentDate})`,
    );
  }

  const sequence = BigInt(series.nextValue);
  const documentNumber = formatDocumentNumber(series.prefix, fy.short, sequence, series.padWidth);
  if (documentNumber.length > series.maxLength) {
    // [VERIFY R-02] maximum length is configurable regulatory data on the series row.
    throw new BusinessRuleError(
      'DOCUMENT_NUMBER_TOO_LONG',
      `Document number ${documentNumber} exceeds the configured maximum of ${series.maxLength} characters`,
    );
  }

  await tx
    .updateTable('system.numberSeries')
    .set({ nextValue: (sequence + 1n).toString(), lastDocumentDate: args.documentDate })
    .where('id', '=', series.id)
    .execute();

  return { documentNumber, fiscalYear: fy.label };
}

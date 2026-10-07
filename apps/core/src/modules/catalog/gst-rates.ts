import type { ItemDto } from '@factory-erp/contracts';
import type { DbExecutor } from '../../db/database';

export interface EffectiveRate {
  ratePercent: string;
  verificationStatus: NonNullable<ItemDto['gstRateStatus']>;
}

const STATUSES = ['DEMO_UNVERIFIED', 'SOURCE_FOUND', 'CA_CONFIRMED'] as const;

function toStatus(s: string): EffectiveRate['verificationStatus'] {
  return STATUSES.find((x) => x === s) ?? 'DEMO_UNVERIFIED';
}

/** Normalise "18.000" → "18", "2.500" → "2.5" (NUMERIC(6,3) comes back padded). */
export function normalisePercent(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * GST rate in force for each HSN code on a business date. Rates are effective-dated data
 * (catalog.gst_rates) — never constants in code [VERIFY R-01].
 */
export async function findEffectiveGstRates(
  db: DbExecutor,
  hsnCodes: readonly string[],
  onDate: string,
): Promise<Map<string, EffectiveRate>> {
  if (hsnCodes.length === 0) return new Map();
  const rows = await db
    .selectFrom('catalog.gstRates')
    .select(['hsnCode', 'ratePercent', 'verificationStatus'])
    .where('hsnCode', 'in', [...new Set(hsnCodes)])
    .where('effectiveFrom', '<=', onDate)
    .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>=', onDate)]))
    .execute();
  return new Map(
    rows.map((r) => [
      r.hsnCode,
      {
        ratePercent: normalisePercent(r.ratePercent),
        verificationStatus: toStatus(r.verificationStatus),
      },
    ]),
  );
}

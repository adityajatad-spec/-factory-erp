export interface FinancialYear {
  /** e.g. "2026-27" */
  label: string;
  /** e.g. "26-27" — used in document numbers */
  short: string;
  /** ISO date, 1 April */
  startDate: string;
  /** ISO date, 31 March */
  endDate: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Indian financial year (1 April – 31 March) containing an ISO business date (YYYY-MM-DD). */
export function financialYearOf(isoDate: string): FinancialYear {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new RangeError(`financialYearOf: expected YYYY-MM-DD, got "${isoDate}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12)
    throw new RangeError(`financialYearOf: invalid month in "${isoDate}"`);

  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  const endShort = String(endYear % 100).padStart(2, '0');
  return {
    label: `${startYear}-${endShort}`,
    short: `${String(startYear % 100).padStart(2, '0')}-${endShort}`,
    startDate: `${startYear}-04-01`,
    endDate: `${endYear}-03-31`,
  };
}

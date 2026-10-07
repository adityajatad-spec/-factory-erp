import { z } from 'zod';

export const Uuid = z.uuid();

/** Business date, ISO YYYY-MM-DD, interpreted in IST (Asia/Kolkata). */
export const IsoDate = z.iso.date();

/** Amount of money as an exact decimal string, max 2 decimals. Never a JS number. */
export const MoneyString = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'Expected an amount like "1234.50"');

/** Quantity: positive decimal string, max 3 decimals. */
export const QtyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,3})?$/, 'Expected a quantity with at most 3 decimals')
  .refine((s) => /[1-9]/.test(s), 'Quantity must be greater than zero');

/** Unit rate: non-negative decimal string, max 4 decimals. */
export const RateString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Expected a rate with at most 4 decimals');

/** Percentage 0..100, max 3 decimals. */
export const PercentString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Expected a percentage like "18" or "2.5"')
  .refine((s) => {
    const [i = '0', f = ''] = s.split('.');
    const int = Number(i);
    return int < 100 || (int === 100 && /^0*$/.test(f));
  }, 'Percentage must be between 0 and 100');

/** 2-digit GST state code. Reference list must be verified [VERIFY R-09]. */
export const StateCode = z.string().regex(/^\d{2}$/, 'Expected a 2-digit state code');

/**
 * GSTIN structural format check only: 2-digit state, 10-char PAN, entity code, 'Z', check char.
 * The check-digit algorithm is not enforced yet [VERIFY R-09].
 */
export const Gstin = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN format'));

export const SearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const VersionedRequest = z.object({
  expectedVersion: z.number().int().positive(),
});

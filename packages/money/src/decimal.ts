import Decimal from 'decimal.js';

/**
 * Isolated Decimal constructor for all financial arithmetic.
 *
 * - High precision so intermediate products (qty × rate × percent) never lose digits.
 * - ROUND_HALF_UP is the *default* only; every rounding call in this codebase passes an
 *   explicit mode so policy is visible at the call site.
 * - Never use `Decimal` (the global, mutable-config constructor) directly.
 */
export const Dec = Decimal.clone({
  precision: 60,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

export type Dec = Decimal;

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN';

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
};

export function toDecimalRounding(mode: RoundingMode): Decimal.Rounding {
  return MODES[mode];
}

/** Plain decimal string: optional minus, digits, optional fraction. No exponents, no grouping. */
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export class DecimalFormatError extends Error {
  readonly label: string;
  readonly input: unknown;

  constructor(label: string, input: unknown) {
    super(`${label}: expected a decimal string like "123.45", got ${JSON.stringify(input)}`);
    this.name = 'DecimalFormatError';
    this.label = label;
    this.input = input;
  }
}

/**
 * Parse an exact decimal from a string. Numbers are rejected on purpose: by the time a
 * value is a JS number it may already have lost precision.
 */
export function parseDecimal(input: unknown, label = 'value'): Dec {
  if (typeof input !== 'string' || !DECIMAL_STRING.test(input)) {
    throw new DecimalFormatError(label, input);
  }
  return new Dec(input);
}

export function isDecimalString(input: unknown): input is string {
  return typeof input === 'string' && DECIMAL_STRING.test(input);
}

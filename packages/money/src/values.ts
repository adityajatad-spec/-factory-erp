import {
  Dec,
  DecimalFormatError,
  parseDecimal,
  toDecimalRounding,
  type RoundingMode,
} from './decimal';

/**
 * A decimal value with a fixed maximum scale. Constructing a value with more fractional
 * digits than allowed is an error — rounding must always be an explicit, named step.
 */
abstract class ScaledValue {
  protected readonly value: Dec;

  protected constructor(value: Dec) {
    this.value = value;
  }

  toDecimal(): Dec {
    return this.value;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
}

function assertScale(d: Dec, scale: number, label: string, input: string): void {
  if (d.decimalPlaces() > scale) {
    throw new DecimalFormatError(`${label} (max ${scale} decimal places)`, input);
  }
}

/** Indian Rupee amount, at most 2 decimal places (paise). */
export class Money extends ScaledValue {
  static readonly SCALE = 2;

  static of(amount: string): Money {
    const d = parseDecimal(amount, 'Money');
    assertScale(d, Money.SCALE, 'Money', amount);
    return new Money(d);
  }

  static zero(): Money {
    return new Money(new Dec(0));
  }

  /** The only way to turn an arbitrary-precision intermediate into Money. */
  static round(value: Dec, mode: RoundingMode): Money {
    return new Money(value.toDecimalPlaces(Money.SCALE, toDecimalRounding(mode)));
  }

  /** Round to whole rupees (e.g. invoice grand total). */
  roundToRupee(mode: RoundingMode): Money {
    return new Money(this.value.toDecimalPlaces(0, toDecimalRounding(mode)));
  }

  plus(other: Money): Money {
    return new Money(this.value.plus(other.value));
  }

  minus(other: Money): Money {
    return new Money(this.value.minus(other.value));
  }

  negated(): Money {
    return new Money(this.value.negated());
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  compare(other: Money): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  /** Fixed 2-decimal string, e.g. "1234.50". This is the wire and storage format. */
  override toString(): string {
    return this.value.toFixed(Money.SCALE);
  }

  toJSON(): string {
    return this.toString();
  }

  static sum(values: readonly Money[]): Money {
    return values.reduce((acc, m) => acc.plus(m), Money.zero());
  }
}

/** Quantity, at most 3 decimal places (e.g. kg to the gram). */
export class Qty extends ScaledValue {
  static readonly SCALE = 3;

  static of(quantity: string): Qty {
    const d = parseDecimal(quantity, 'Qty');
    assertScale(d, Qty.SCALE, 'Qty', quantity);
    return new Qty(d);
  }

  override toString(): string {
    return this.value.toFixed(Qty.SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Unit price, at most 4 decimal places (per-kg prices often need more than paise). */
export class Rate extends ScaledValue {
  static readonly SCALE = 4;

  static of(rate: string): Rate {
    const d = parseDecimal(rate, 'Rate');
    assertScale(d, Rate.SCALE, 'Rate', rate);
    return new Rate(d);
  }

  override toString(): string {
    return this.value.toFixed(Rate.SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Percentage between 0 and 100 inclusive, at most 3 decimal places (e.g. "18", "2.5"). */
export class Percent extends ScaledValue {
  static readonly SCALE = 3;

  static of(percent: string): Percent {
    const d = parseDecimal(percent, 'Percent');
    assertScale(d, Percent.SCALE, 'Percent', percent);
    if (d.isNegative() || d.greaterThan(100)) {
      throw new DecimalFormatError('Percent (0 to 100)', percent);
    }
    return new Percent(d);
  }

  /** Half of this percentage, exact (used for CGST/SGST split). */
  half(): Percent {
    return new Percent(this.value.dividedBy(2));
  }

  /** value × (this / 100), unrounded. */
  applyTo(amount: Dec): Dec {
    return amount.times(this.value).dividedBy(100);
  }

  /** Normalised string without trailing zeros, e.g. "18", "2.5", "0.125". */
  override toString(): string {
    return this.value.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}

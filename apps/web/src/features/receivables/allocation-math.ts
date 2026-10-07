import { isDecimalString, Money } from '@factory-erp/money';

export interface OpenAmount {
  invoiceId: string;
  outstandingAmount: string;
}

/** Parse a user-typed amount; empty means zero, anything malformed is null. */
export function parseAmount(input: string): Money | null {
  const v = input.trim();
  if (v === '') return Money.zero();
  if (!isDecimalString(v) || v.startsWith('-')) return null;
  try {
    return Money.of(v);
  } catch {
    return null; // more than 2 decimals
  }
}

/**
 * Suggest allocations oldest-first until `available` runs out. A convenience for the person
 * entering the receipt — the server validates every allocation independently.
 */
export function allocateOldestFirst(
  available: string,
  invoices: readonly OpenAmount[],
): Record<string, string> {
  let left = parseAmount(available) ?? Money.zero();
  const result: Record<string, string> = {};
  for (const inv of invoices) {
    if (!left.isPositive()) break;
    const owed = Money.of(inv.outstandingAmount);
    const take = owed.compare(left) <= 0 ? owed : left;
    if (take.isPositive()) {
      result[inv.invoiceId] = take.toString();
      left = left.minus(take);
    }
  }
  return result;
}

export interface AllocationCheck {
  total: Money;
  remaining: Money | null;
  rowErrors: Record<string, string>;
  overAllocated: boolean;
  valid: boolean;
}

/** Client-side mirror of the server rules, for instant feedback only. */
export function checkDraftAllocations(
  available: string | null,
  invoices: readonly OpenAmount[],
  amounts: Readonly<Record<string, string>>,
): AllocationCheck {
  let total = Money.zero();
  const rowErrors: Record<string, string> = {};
  for (const inv of invoices) {
    const raw = amounts[inv.invoiceId] ?? '';
    const amount = parseAmount(raw);
    if (!amount) {
      rowErrors[inv.invoiceId] = 'Enter an amount like 1234.50';
      continue;
    }
    if (amount.compare(Money.of(inv.outstandingAmount)) > 0) {
      rowErrors[inv.invoiceId] = 'More than the outstanding amount';
    }
    total = total.plus(amount);
  }
  const avail = available === null ? null : parseAmount(available);
  const remaining = avail ? avail.minus(total) : null;
  const overAllocated = remaining !== null && remaining.isNegative();
  return {
    total,
    remaining,
    rowErrors,
    overAllocated,
    valid: Object.keys(rowErrors).length === 0 && !overAllocated,
  };
}

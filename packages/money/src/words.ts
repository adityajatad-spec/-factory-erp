import type { Money } from './values';

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = ONES[n % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ''} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

const CRORE = 10_000_000n;
const LAKH = 100_000n;
const THOUSAND = 1_000n;

/** Indian-system words for a non-negative integer (crore / lakh / thousand / hundred). */
export function integerToIndianWords(n: bigint): string {
  if (n < 0n) throw new RangeError('integerToIndianWords: negative values are not supported');
  if (n === 0n) return 'Zero';

  const parts: string[] = [];
  const crores = n / CRORE;
  let rest = n % CRORE;
  if (crores > 0n) parts.push(`${integerToIndianWords(crores)} Crore`);

  const lakhs = Number(rest / LAKH);
  rest %= LAKH;
  if (lakhs > 0) parts.push(`${belowHundred(lakhs)} Lakh`);

  const thousands = Number(rest / THOUSAND);
  rest %= THOUSAND;
  if (thousands > 0) parts.push(`${belowHundred(thousands)} Thousand`);

  const remainder = Number(rest);
  if (remainder > 0) parts.push(belowThousand(remainder));

  return parts.join(' ');
}

/**
 * Amount in words for invoices, e.g.
 * "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only".
 * The wording is a template choice and may later become company-configurable.
 */
export function amountInWordsINR(amount: Money): string {
  if (amount.isNegative())
    throw new RangeError('amountInWordsINR: negative amounts are not supported');
  const [rupeesPart = '0', paisePart = '00'] = amount.toString().split('.');
  const rupees = integerToIndianWords(BigInt(rupeesPart));
  const paise = Number(paisePart);
  return paise > 0
    ? `Rupees ${rupees} and ${belowHundred(paise)} Paise Only`
    : `Rupees ${rupees} Only`;
}

import { describe, expect, it } from 'vitest';
import { Money } from './values';
import { amountInWordsINR, integerToIndianWords } from './words';

describe('integerToIndianWords', () => {
  it.each([
    [0n, 'Zero'],
    [7n, 'Seven'],
    [15n, 'Fifteen'],
    [40n, 'Forty'],
    [99n, 'Ninety Nine'],
    [100n, 'One Hundred'],
    [101n, 'One Hundred One'],
    [1000n, 'One Thousand'],
    [100000n, 'One Lakh'],
    [123456n, 'One Lakh Twenty Three Thousand Four Hundred Fifty Six'],
    [10000000n, 'One Crore'],
    [
      987654321n,
      'Ninety Eight Crore Seventy Six Lakh Fifty Four Thousand Three Hundred Twenty One',
    ],
    [
      12345678901n,
      'One Thousand Two Hundred Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred One',
    ],
  ])('%s → %s', (n, words) => {
    expect(integerToIndianWords(n)).toBe(words);
  });
});

describe('amountInWordsINR', () => {
  it('includes paise when present', () => {
    expect(amountInWordsINR(Money.of('123456.78'))).toBe(
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only',
    );
  });

  it('omits paise when zero', () => {
    expect(amountInWordsINR(Money.of('5900'))).toBe('Rupees Five Thousand Nine Hundred Only');
  });

  it('handles zero', () => {
    expect(amountInWordsINR(Money.zero())).toBe('Rupees Zero Only');
  });

  it('rejects negative amounts', () => {
    expect(() => amountInWordsINR(Money.of('-1'))).toThrow(RangeError);
  });
});

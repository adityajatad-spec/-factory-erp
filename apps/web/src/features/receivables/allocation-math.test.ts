import { describe, expect, it } from 'vitest';
import { allocateOldestFirst, checkDraftAllocations, parseAmount } from './allocation-math';

const open = [
  { invoiceId: 'a', outstandingAmount: '1000.00' },
  { invoiceId: 'b', outstandingAmount: '250.50' },
  { invoiceId: 'c', outstandingAmount: '99.99' },
];

describe('allocateOldestFirst', () => {
  it('fills invoices oldest first and stops when money runs out', () => {
    expect(allocateOldestFirst('1100', open)).toEqual({ a: '1000.00', b: '100.00' });
  });

  it('pays everything and leaves the rest unallocated when the receipt is larger', () => {
    expect(allocateOldestFirst('5000', open)).toEqual({ a: '1000.00', b: '250.50', c: '99.99' });
  });

  it('returns nothing for zero or invalid amounts', () => {
    expect(allocateOldestFirst('0', open)).toEqual({});
    expect(allocateOldestFirst('abc', open)).toEqual({});
  });
});

describe('checkDraftAllocations', () => {
  it('totals amounts and reports the remainder', () => {
    const r = checkDraftAllocations('2000', open, { a: '1000', b: '250.50' });
    expect(r.valid).toBe(true);
    expect(r.total.toString()).toBe('1250.50');
    expect(r.remaining?.toString()).toBe('749.50');
  });

  it('flags rows above outstanding, malformed input and over-allocation', () => {
    const r = checkDraftAllocations('100', open, { a: '1000.01', b: '1.234', c: '99.99' });
    expect(r.rowErrors).toEqual({
      a: 'More than the outstanding amount',
      b: 'Enter an amount like 1234.50',
    });
    expect(r.overAllocated).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('parses amounts strictly', () => {
    expect(parseAmount('')?.toString()).toBe('0.00');
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('1,000')).toBeNull();
  });
});

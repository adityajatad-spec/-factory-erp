import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { threeWayMatch, type MatchInvoiceLine, type MatchOrderLine } from './matching';

const NONE = { qtyPercent: '0', pricePercent: '0', totalAmount: '1.00' };

const orderLine = (o: Partial<MatchOrderLine> = {}): MatchOrderLine => ({
  lineNo: 1,
  itemId: 'steel',
  itemCode: 'RM-STEEL',
  unitRate: '50.0000',
  discountPercent: '0',
  acceptedQuantity: '100.000',
  invoicedQuantity: '0.000',
  ...o,
});

const billLine = (o: Partial<MatchInvoiceLine> = {}): MatchInvoiceLine => ({
  lineNo: 1,
  itemId: 'steel',
  itemCode: 'RM-STEEL',
  orderLineNo: 1,
  quantity: '100.000',
  unitRate: '50.0000',
  discountPercent: '0',
  ...o,
});

const match = (
  lines: MatchInvoiceLine[],
  opts: {
    order?: MatchOrderLine[] | null;
    computed?: string;
    stated?: string;
    t?: typeof NONE;
  } = {},
) =>
  threeWayMatch({
    tolerances: opts.t ?? NONE,
    order: opts.order === null ? null : { lines: opts.order ?? [orderLine()] },
    lines,
    computedTotal: opts.computed ?? '5900.00',
    supplierStatedTotal: opts.stated ?? '5900.00',
  });

const codes = (f: ReturnType<typeof match>) => f.map((x) => x.code);

describe('three-way match', () => {
  it('finds nothing when the bill agrees with the order and what was received', () => {
    expect(match([billLine()])).toEqual([]);
  });

  it('flags billing for more than was accepted, counting earlier bills', () => {
    expect(codes(match([billLine({ quantity: '100.001' })]))).toEqual(['QTY_EXCEEDS_RECEIVED']);
    const f = match([billLine({ quantity: '30' })], {
      order: [orderLine({ invoicedQuantity: '80.000' })],
    });
    expect(f).toMatchObject([
      { code: 'QTY_EXCEEDS_RECEIVED', expected: '100.000', actual: '110.000', orderLineNo: 1 },
    ]);
  });

  it('flags a net price above the order, but not a lower one', () => {
    expect(codes(match([billLine({ unitRate: '50.0100' })]))).toEqual(['PRICE_ABOVE_ORDER']);
    expect(match([billLine({ unitRate: '49' })])).toEqual([]);
    // Same net price expressed with a discount: ₹62.50 less 20 % = ₹50.
    expect(match([billLine({ unitRate: '62.5', discountPercent: '20' })])).toEqual([]);
  });

  it('flags a different item and a charge not on the order', () => {
    const f = match([
      billLine({ itemId: 'copper', itemCode: 'RM-CU' }),
      billLine({ lineNo: 2, orderLineNo: null, itemId: 'freight', itemCode: 'SVC-FRT' }),
    ]);
    expect(f).toMatchObject([
      { code: 'ITEM_MISMATCH', invoiceLineNo: 1, expected: 'RM-STEEL', actual: 'RM-CU' },
      { code: 'NOT_ON_ORDER', invoiceLineNo: 2 },
    ]);
  });

  it("compares the supplier's total with ours within the ₹ tolerance — for direct bills too", () => {
    expect(match([billLine()], { stated: '5901.00' })).toEqual([]);
    expect(match([billLine()], { stated: '5901.01' })).toMatchObject([
      { code: 'TOTAL_MISMATCH', expected: '5900.00', actual: '5901.01' },
    ]);
    expect(
      codes(match([billLine({ orderLineNo: null })], { order: null, stated: '5800.00' })),
    ).toEqual(['TOTAL_MISMATCH']);
    // A direct bill is never matched line by line.
    expect(match([billLine({ orderLineNo: null, quantity: '999' })], { order: null })).toEqual([]);
  });

  it('applies configurable quantity and price tolerances', () => {
    const t = { qtyPercent: '5', pricePercent: '2', totalAmount: '1.00' };
    expect(match([billLine({ quantity: '105', unitRate: '51' })], { t })).toEqual([]);
    expect(codes(match([billLine({ quantity: '105.001', unitRate: '51.0001' })], { t }))).toEqual([
      'QTY_EXCEEDS_RECEIVED',
      'PRICE_ABOVE_ORDER',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties: the decimal implementation agrees with an independent integer oracle.
// Quantities in thousandths, rates in ten-thousandths, percents in thousandths, money in paise.
// ---------------------------------------------------------------------------------------------

const milli = (n: bigint) => `${n / 1000n}.${(n % 1000n).toString().padStart(3, '0')}`;
const tenThousandths = (n: bigint) => `${n / 10000n}.${(n % 10000n).toString().padStart(4, '0')}`;
const paise = (n: bigint) => `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;

const qty = fc.bigInt({ min: 1n, max: 10_000_000n });
const rate = fc.bigInt({ min: 0n, max: 100_000_000n });
const pct = fc.bigInt({ min: 0n, max: 100_000n });
const money = fc.bigInt({ min: 0n, max: 1_000_000_000n });

describe('three-way match properties', () => {
  it('quantity: flagged exactly when billed (earlier + now) > accepted × (1 + tol %)', () => {
    fc.assert(
      fc.property(
        qty,
        qty,
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        pct,
        (acc, now, before, t) => {
          const f = match([billLine({ quantity: milli(now) })], {
            order: [orderLine({ acceptedQuantity: milli(acc), invoicedQuantity: milli(before) })],
            t: { ...NONE, qtyPercent: milli(t) },
          });
          // (before + now) > acc × (100000 + t) / 100000
          const expected = (before + now) * 100_000n > acc * (100_000n + t);
          expect(codes(f).includes('QTY_EXCEEDS_RECEIVED')).toBe(expected);
        },
      ),
    );
  });

  it('price: flagged exactly when the billed net price > ordered net price × (1 + tol %)', () => {
    fc.assert(
      fc.property(rate, pct, rate, pct, pct, (rb, db, ro, dor, t) => {
        const f = match([billLine({ unitRate: tenThousandths(rb), discountPercent: milli(db) })], {
          order: [orderLine({ unitRate: tenThousandths(ro), discountPercent: milli(dor) })],
          t: { ...NONE, pricePercent: milli(t) },
        });
        const expected = rb * (100_000n - db) * 100_000n > ro * (100_000n - dor) * (100_000n + t);
        expect(codes(f).includes('PRICE_ABOVE_ORDER')).toBe(expected);
      }),
    );
  });

  it('total: flagged exactly when |computed − stated| > tolerance', () => {
    fc.assert(
      fc.property(money, money, fc.bigInt({ min: 0n, max: 100_000n }), (c, s, tol) => {
        const f = match([billLine()], {
          computed: paise(c),
          stated: paise(s),
          t: { ...NONE, totalAmount: paise(tol) },
        });
        const diff = c > s ? c - s : s - c;
        expect(codes(f).includes('TOTAL_MISMATCH')).toBe(diff > tol);
      }),
    );
  });

  it('is deterministic and does not depend on the order of the bill lines', () => {
    const line = fc.record({
      orderLineNo: fc.constantFrom(1, 2, 3, null),
      quantity: qty.map(milli),
      unitRate: rate.map(tenThousandths),
    });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (ls) => {
        const lines = ls.map((l, i) => billLine({ ...l, lineNo: i + 1 }));
        const order = [1, 2, 3].map((n) => orderLine({ lineNo: n }));
        const key = (f: ReturnType<typeof match>) =>
          f.map((x) => `${x.code}:${x.invoiceLineNo}`).sort();
        const forward = match(lines, { order });
        expect(match(lines, { order })).toEqual(forward);
        expect(key(match([...lines].reverse(), { order }))).toEqual(key(forward));
      }),
    );
  });
});

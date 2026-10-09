import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { purchaseFlows } from '../../../test/purchase-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { ForbiddenError, ValidationError } from '../../platform/errors';
import { createItem } from '../catalog';
import { listStock, listStockMovements } from '../inventory';
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  GOODS_RECEIPT_SOURCE,
  recordGoodsReceipt,
} from './index';

const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
const p = purchaseFlows(
  () => env,
  () => fx,
  TODAY,
);
const cmd = () => env.services.commands;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const receive = (
  orderId: string,
  lines: Array<{
    orderLineNo: number;
    acceptedQuantity: string;
    rejectedQuantity?: string;
    rejectionReason?: string;
  }>,
  opts: { actor?: Fixture['actors']['owner']; key?: string; date?: string } = {},
) =>
  cmd().execute(
    recordGoodsReceipt,
    { orderId, receiptDate: opts.date ?? TODAY, supplierReference: 'DC-77', lines },
    opts.actor ?? fx.actors.supervisor,
    opts.key ? { idempotencyKey: opts.key } : {},
  );
const stockOf = async (itemId: string) =>
  (
    await env.services.queries.execute(
      listStock,
      { itemId, warehouseId: fx.warehouse.id, includeZero: 'true' },
      fx.actors.owner,
    )
  )[0]?.quantity ?? '0.000';

describe('partial and full receipt', () => {
  it('100 ordered → 40 received → 60 remaining → 60 received → RECEIVED; stock follows exactly', async () => {
    const before = await stockOf(fx.items.rawMaterial.id);
    const po = await p.approvedPo([p.steel('100', '50')]);

    const g1 = await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '40' }]);
    expect(g1.grnNumber).toMatch(/^GRN\/26-27\/\d{5}$/);
    let o = await p.order(po.id);
    expect(o.status).toBe('PARTIALLY_RECEIVED');
    expect(o.lines[0]).toMatchObject({ acceptedQuantity: '40.000', remainingQuantity: '60.000' });
    expect(o.receipts.map((r) => r.grnNumber)).toEqual([g1.grnNumber]);

    await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '60' }]);
    o = await p.order(po.id);
    expect(o.status).toBe('RECEIVED');
    expect(o.lines[0]?.remainingQuantity).toBe('0.000');
    expect(Number(await stockOf(fx.items.rawMaterial.id)) - Number(before)).toBe(100);

    // The stock ledger points back at the receipt line that moved the stock.
    const moves = await env.services.queries.execute(
      listStockMovements,
      { sourceId: g1.id },
      fx.actors.owner,
    );
    expect(moves).toEqual([
      expect.objectContaining({
        movementType: 'RECEIPT',
        quantity: '40.000',
        uom: 'KGS',
        sourceType: GOODS_RECEIPT_SOURCE,
        reference: g1.grnNumber,
        warehouseCode: 'STORE',
      }),
    ]);
  });

  it('refuses an over-receipt and records nothing at all', async () => {
    const po = await p.approvedPo([p.steel('100', '50')]);
    const before = await stockOf(fx.items.rawMaterial.id);
    const err = await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '100.001' }]).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ rule: 'OVER_RECEIPT' });
    expect((err as Error).message).toMatch(/only 100\.000 KGS remain/);
    expect(await stockOf(fx.items.rawMaterial.id)).toBe(before);
    expect((await p.order(po.id)).status).toBe('APPROVED');
  });

  it('rejected goods need a reason, are not stocked and do not use up the order', async () => {
    const po = await p.approvedPo([p.steel('100', '50')]);
    const before = await stockOf(fx.items.rawMaterial.id);
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '30', rejectedQuantity: '10' }]),
    ).rejects.toBeInstanceOf(ValidationError);
    const g = await receive(po.id, [
      {
        orderLineNo: 1,
        acceptedQuantity: '30',
        rejectedQuantity: '10',
        rejectionReason: 'Rusted edges',
      },
    ]);
    expect(g.lines[0]).toMatchObject({
      receivedQuantity: '40.000',
      acceptedQuantity: '30.000',
      rejectedQuantity: '10.000',
    });
    expect(Number(await stockOf(fx.items.rawMaterial.id)) - Number(before)).toBe(30);
    expect((await p.order(po.id)).lines[0]).toMatchObject({
      rejectedQuantity: '10.000',
      remainingQuantity: '70.000',
    });
  });

  it('a delivery that is entirely rejected leaves the order APPROVED (nothing accepted yet)', async () => {
    const po = await p.approvedPo([p.steel('10', '50')]);
    await receive(po.id, [
      {
        orderLineNo: 1,
        acceptedQuantity: '0',
        rejectedQuantity: '10',
        rejectionReason: 'Wrong grade',
      },
    ]);
    const o = await p.order(po.id);
    expect(o.status).toBe('APPROVED');
    expect(o.lines[0]).toMatchObject({ rejectedQuantity: '10.000', remainingQuantity: '10.000' });
  });

  it('receives several items in one GRN; a service is received but never stocked', async () => {
    const svc = await cmd().execute(
      createItem,
      { code: 'SVC-CUT', name: 'Laser cutting', itemType: 'SERVICE', uom: 'NOS', hsnCode: '7326' },
      fx.actors.owner,
    );
    const po = await p.approvedPo([
      p.steel('10', '50'),
      { itemId: fx.items.carton.id, quantity: '200', unitRate: '9' },
      { itemId: svc.id, quantity: '5', unitRate: '100' },
    ]);
    const cartonBefore = await stockOf(fx.items.carton.id);
    const g = await receive(po.id, [
      { orderLineNo: 1, acceptedQuantity: '10' },
      { orderLineNo: 2, acceptedQuantity: '200' },
      { orderLineNo: 3, acceptedQuantity: '5' },
    ]);
    expect((await p.order(po.id)).status).toBe('RECEIVED');
    expect(Number(await stockOf(fx.items.carton.id)) - Number(cartonBefore)).toBe(200);
    const moves = await env.services.queries.execute(
      listStockMovements,
      { sourceId: g.id },
      fx.actors.owner,
    );
    expect(moves.map((m) => m.itemId).sort()).toEqual(
      [fx.items.carton.id, fx.items.rawMaterial.id].sort(),
    );
  });
});

describe('only open orders receive goods', () => {
  it('drafts, closed and fully received orders refuse goods; a received order cannot be cancelled', async () => {
    const draft = await p.draftPo();
    await expect(
      receive(draft.id, [{ orderLineNo: 1, acceptedQuantity: '1' }]),
    ).rejects.toMatchObject({
      rule: 'PURCHASE_ORDER_NOT_OPEN',
    });
    const po = await p.approvedPo([p.steel('100', '50')]);
    await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '25' }]);
    const part = await p.order(po.id);
    await expect(
      cmd().execute(
        cancelPurchaseOrder,
        { orderId: po.id, expectedVersion: part.version, reason: 'too late' },
        fx.actors.owner,
      ),
    ).rejects.toMatchObject({ rule: 'PURCHASE_ORDER_STATUS' });
    const closed = await cmd().execute(
      closePurchaseOrder,
      { orderId: po.id, expectedVersion: part.version, reason: 'Supplier cannot deliver the rest' },
      fx.actors.owner,
    );
    expect(closed.status).toBe('CLOSED');
    await expect(receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }])).rejects.toMatchObject(
      {
        rule: 'PURCHASE_ORDER_NOT_OPEN',
      },
    );
  });

  it('a receipt cannot be future-dated or dated before its order', async () => {
    const po = await p.approvedPo([p.steel('10', '50')]);
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }], { date: '2026-10-06' }),
    ).rejects.toMatchObject({
      rule: 'RECEIPT_DATE_IN_FUTURE',
    });
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }], { date: '2026-10-01' }),
    ).rejects.toMatchObject({
      rule: 'RECEIPT_BEFORE_ORDER',
    });
  });
});

describe('concurrency, idempotency and the database', () => {
  it('two receipts racing for the last 60 units: exactly one wins', async () => {
    const po = await p.approvedPo([p.steel('100', '50')]);
    await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '40' }]);
    const results = await Promise.allSettled([
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '40' }]),
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '40' }]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await p.order(po.id)).lines[0]?.acceptedQuantity).toBe('80.000');
  });

  it('a retried receipt (same Idempotency-Key) is recorded and stocked once', async () => {
    const po = await p.approvedPo([p.steel('10', '50')]);
    const before = await stockOf(fx.items.rawMaterial.id);
    const once = await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '4' }], {
      key: 'grn-retry-0001',
    });
    const twice = await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '4' }], {
      key: 'grn-retry-0001',
    });
    expect(twice).toEqual(once);
    expect(Number(await stockOf(fx.items.rawMaterial.id)) - Number(before)).toBe(4);
  });

  it('SQL refuses an over-receipt written behind the application’s back (FO006)', async () => {
    const po = await p.approvedPo([p.steel('10', '50')]);
    await receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '5' }]);
    await expect(
      env.ownerDb.transaction().execute(async (tx) => {
        const id = crypto.randomUUID();
        await sql`insert into purchase.goods_receipts (id, company_id, grn_number, fiscal_year, receipt_date, order_id, supplier_id, warehouse_id, created_by)
                  values (${id}, ${fx.companyId}, 'RAW-1', '2026-27', ${TODAY}, ${po.id}, ${po.supplierId}, ${fx.warehouse.id}, ${fx.actors.owner.user.id})`.execute(
          tx,
        );
        await sql`insert into purchase.goods_receipt_lines (grn_id, line_no, order_id, order_line_no, item_id, received_quantity, accepted_quantity, rejected_quantity)
                  values (${id}, 1, ${po.id}, 1, ${fx.items.rawMaterial.id}, 6, 6, 0)`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: 'FO006' });
  });

  it('receipts are append-only (runtime: no privilege; owner: trigger)', async () => {
    for (const [db, code] of [
      [env.services.db, '42501'],
      [env.ownerDb, 'FO001'],
    ] as const) {
      await expect(
        sql`update purchase.goods_receipt_lines set accepted_quantity = 0`.execute(db),
      ).rejects.toMatchObject({ code });
      await expect(sql`delete from purchase.goods_receipts`.execute(db)).rejects.toMatchObject({
        code,
      });
    }
  });

  it('the stores (supervisor) receive goods; accountants and the AI cannot', async () => {
    const po = await p.approvedPo([p.steel('10', '50')]);
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }], { actor: fx.actors.accountant }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }], {
        actor: asAiAgent(fx.actors.owner),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '1' }]),
    ).resolves.toBeDefined();
  });
});

describe('receipt invariants (property test over random receipt sequences)', () => {
  it('Σ accepted ≤ ordered, remaining = ordered − Σ accepted, stock = Σ accepted, status follows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60 }),
        fc.array(
          fc.record({
            accepted: fc.integer({ min: 0, max: 40 }),
            rejected: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (ordered, attempts) => {
          const po = await p.approvedPo([p.steel(String(ordered), '10')]);
          const before = Number(await stockOf(fx.items.rawMaterial.id));
          let accepted = 0;
          for (const a of attempts) {
            const remaining = ordered - accepted;
            try {
              await receive(po.id, [
                {
                  orderLineNo: 1,
                  acceptedQuantity: String(a.accepted),
                  rejectedQuantity: String(a.rejected),
                  ...(a.rejected ? { rejectionReason: 'damaged' } : {}),
                },
              ]);
              expect(a.accepted).toBeLessThanOrEqual(remaining);
              accepted += a.accepted;
            } catch (e) {
              // Refused exactly when it would over-receive, receive nothing, or the order is done.
              const why = (e as { rule?: string }).rule ?? 'VALIDATION';
              expect(
                a.accepted > remaining || a.accepted + a.rejected === 0 || remaining === 0,
                `refused (${why}) though ${a.accepted}/${a.rejected} fits ${remaining}`,
              ).toBe(true);
            }
          }
          const o = await p.order(po.id);
          expect(Number(o.lines[0]?.acceptedQuantity)).toBe(accepted);
          expect(Number(o.lines[0]?.remainingQuantity)).toBe(ordered - accepted);
          expect(Number(await stockOf(fx.items.rawMaterial.id)) - before).toBe(accepted);
          expect(o.status).toBe(
            accepted === 0 ? 'APPROVED' : accepted === ordered ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { purchaseFlows } from '../../../test/purchase-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import {
  BusinessRuleError,
  ForbiddenError,
  ValidationError,
  VersionConflictError,
} from '../../platform/errors';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  deletePurchaseOrderDraft,
  listPurchaseOrders,
  updatePurchaseOrderDraft,
} from './index';

const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
let lateOrderId = '';
const p = purchaseFlows(
  () => env,
  () => fx,
  TODAY,
);
const cmd = () => env.services.commands;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
  // First, so its back-dated number keeps the series in date order.
  lateOrderId = (
    await p.approvedPo(undefined, { poDate: '2026-09-20', expectedDate: '2026-09-30' })
  ).id;
});
afterAll(async () => env.destroy());

describe('drafting purchase orders', () => {
  it('prices lines on the server with the shared GST engine (intra-state: CGST + SGST)', async () => {
    const po = await p.draftPo([p.steel('100', '50')]);
    expect(po).toMatchObject({
      status: 'DRAFT',
      poNumber: null,
      supplyType: 'INTRA_STATE',
      taxableAmount: '5000.00',
      cgstAmount: '450.00',
      sgstAmount: '450.00',
      igstAmount: '0.00',
      grandTotal: '5900.00',
    });
    expect(po.lines[0]).toMatchObject({
      uom: 'KGS',
      gstRatePercent: '18.000',
      remainingQuantity: '100.000',
    });
  });

  it('charges IGST for a supplier in another state', async () => {
    const po = await p.draftPo([p.steel('10', '100')], { supplierId: fx.suppliers.outstation.id });
    expect(po).toMatchObject({
      supplyType: 'INTER_STATE',
      igstAmount: '180.00',
      grandTotal: '1180.00',
    });
  });

  it('only buys from active suppliers into a known warehouse, with valid dates', async () => {
    await expect(p.draftPo(undefined, { supplierId: fx.customers.intra.id })).rejects.toMatchObject(
      {
        rule: 'NOT_AN_ACTIVE_SUPPLIER',
      },
    );
    await expect(p.draftPo(undefined, { expectedDate: '2026-10-01' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('edits only drafts, with optimistic versions', async () => {
    const po = await p.draftPo();
    const edited = await cmd().execute(
      updatePurchaseOrderDraft,
      {
        orderId: po.id,
        expectedVersion: po.version,
        supplierId: fx.suppliers.local.id,
        warehouseId: fx.warehouse.id,
        poDate: TODAY,
        expectedDate: '2026-10-12',
        lines: [p.steel('200', '50')],
      },
      fx.actors.purchase,
    );
    expect(edited).toMatchObject({
      grandTotal: '11800.00',
      expectedDate: '2026-10-12',
      version: po.version + 1,
    });
    await expect(
      cmd().execute(
        updatePurchaseOrderDraft,
        {
          orderId: po.id,
          expectedVersion: po.version,
          supplierId: fx.suppliers.local.id,
          warehouseId: fx.warehouse.id,
          poDate: TODAY,
          lines: [p.steel()],
        },
        fx.actors.purchase,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('approval', () => {
  it('drafting and approving are separate permissions; the AI may only draft', async () => {
    const draft = await p.draftPo();
    await expect(
      cmd().execute(
        approvePurchaseOrder,
        { orderId: draft.id, expectedVersion: draft.version },
        fx.actors.purchase,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(p.draftPo(undefined, { actor: fx.actors.accountant })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const aiDraft = await p.draftPo(undefined, { actor: asAiAgent(fx.actors.owner) });
    expect(aiDraft.status).toBe('DRAFT');
    await expect(
      cmd().execute(
        approvePurchaseOrder,
        { orderId: aiDraft.id, expectedVersion: aiDraft.version },
        asAiAgent(fx.actors.owner),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('numbers the order and freezes it — in the command and in SQL', async () => {
    const po = await p.approvedPo();
    expect(po.status).toBe('APPROVED');
    expect(po.poNumber).toMatch(/^PO\/26-27\/\d{5}$/);
    expect(po.approvedByName).toBe('owner');
    await expect(
      cmd().execute(
        updatePurchaseOrderDraft,
        {
          orderId: po.id,
          expectedVersion: po.version,
          supplierId: fx.suppliers.local.id,
          warehouseId: fx.warehouse.id,
          poDate: TODAY,
          lines: [p.steel()],
        },
        fx.actors.purchase,
      ),
    ).rejects.toMatchObject({ rule: 'PURCHASE_ORDER_STATUS' });
    const db = env.services.db;
    await expect(
      sql`update purchase.orders set grand_total = 1 where id = ${po.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`update purchase.order_lines set quantity = 1 where order_id = ${po.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`delete from purchase.orders where id = ${po.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`update purchase.orders set status = 'DRAFT' where id = ${po.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
  });

  it('numbering is gapless and unique when many orders are approved at once', async () => {
    const drafts = await Promise.all([1, 2, 3, 4, 5, 6].map(() => p.draftPo()));
    const approved = await Promise.all(
      drafts.map((d) =>
        cmd().execute(
          approvePurchaseOrder,
          { orderId: d.id, expectedVersion: d.version },
          fx.actors.owner,
        ),
      ),
    );
    const seq = approved.map((o) => Number(o.poNumber?.split('/')[2])).sort((a, b) => a - b);
    expect(new Set(seq).size).toBe(6);
    expect(seq.at(-1)! - seq[0]!).toBe(5);
  });

  it('a retried approval (same Idempotency-Key) does not approve twice', async () => {
    const d = await p.draftPo();
    const key = 'po-approve-retry-1';
    const once = await cmd().execute(
      approvePurchaseOrder,
      { orderId: d.id, expectedVersion: d.version },
      fx.actors.owner,
      { idempotencyKey: key },
    );
    const twice = await cmd().execute(
      approvePurchaseOrder,
      { orderId: d.id, expectedVersion: d.version },
      fx.actors.owner,
      { idempotencyKey: key },
    );
    expect(twice).toEqual(once);
  });
});

describe('ending an order', () => {
  it('cancels a draft or an approved order with a reason; a draft can also be deleted', async () => {
    const d = await p.draftPo();
    const cancelled = await cmd().execute(
      cancelPurchaseOrder,
      { orderId: d.id, expectedVersion: d.version, reason: 'Supplier changed' },
      fx.actors.owner,
    );
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Supplier changed',
      poNumber: null,
    });

    const a = await p.approvedPo();
    const c2 = await cmd().execute(
      cancelPurchaseOrder,
      { orderId: a.id, expectedVersion: a.version, reason: 'Price renegotiated' },
      fx.actors.owner,
    );
    expect(c2).toMatchObject({ status: 'CANCELLED', poNumber: a.poNumber });

    const d2 = await p.draftPo();
    await cmd().execute(
      deletePurchaseOrderDraft,
      { orderId: d2.id, expectedVersion: d2.version },
      fx.actors.purchase,
    );
    await expect(p.order(d2.id)).rejects.toThrow(/not found/);
    await expect(
      cmd().execute(
        deletePurchaseOrderDraft,
        { orderId: a.id, expectedVersion: c2.version },
        fx.actors.owner,
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('short-closes only approved or part-received orders', async () => {
    const d = await p.draftPo();
    await expect(
      cmd().execute(
        closePurchaseOrder,
        { orderId: d.id, expectedVersion: d.version, reason: 'not needed' },
        fx.actors.owner,
      ),
    ).rejects.toMatchObject({ rule: 'PURCHASE_ORDER_STATUS' });
    const a = await p.approvedPo();
    const closed = await cmd().execute(
      closePurchaseOrder,
      { orderId: a.id, expectedVersion: a.version, reason: 'Not needed any more' },
      fx.actors.owner,
    );
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'Not needed any more' });
  });
});

describe('finding orders', () => {
  it('flags open orders past their expected date as overdue', async () => {
    const overdue = await env.services.queries.execute(
      listPurchaseOrders,
      { overdue: 'true' },
      fx.actors.owner,
    );
    expect(overdue.map((o) => o.id)).toEqual([lateOrderId]);
    expect(overdue.every((o) => o.isOverdue)).toBe(true);
    expect((await p.order(lateOrderId)).isOverdue).toBe(true);
  });
});

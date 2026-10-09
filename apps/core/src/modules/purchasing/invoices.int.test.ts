import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { purchaseFlows } from '../../../test/purchase-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { ForbiddenError, ValidationError, VersionConflictError } from '../../platform/errors';
import { getPurchaseOrder, matchPurchaseInvoice, postPurchaseInvoice } from './index';

const TODAY = '2026-10-06';
let env: TestEnv;
let fx: Fixture;
const p = purchaseFlows(
  () => env,
  () => fx,
  TODAY,
);
const qry = () => env.services.queries;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const ledgerOf = (invoiceId: string) =>
  env.services.db
    .selectFrom('finance.payableLedgerEntries')
    .select(['entryType', 'debit', 'credit', 'entryDate', 'partyId'])
    .where('sourceId', '=', invoiceId)
    .execute();

/** A PO for 100 kg @ ₹50, of which `received` kg arrived and were accepted. */
async function orderWithReceipt(received: string) {
  const po = await p.approvedPo([p.steel('100', '50')]);
  if (received !== '0') await p.receive(po.id, [{ orderLineNo: 1, acceptedQuantity: received }]);
  return po;
}
const billLine = (quantity: string, unitRate = '50') => ({
  itemId: fx.items.rawMaterial.id,
  orderLineNo: 1,
  quantity,
  unitRate,
});

describe('PO-based bill that matches', () => {
  it('posts: numbered by posting date, frozen, owed to the supplier, visible on the order', async () => {
    const po = await orderWithReceipt('100');
    const draft = await p.draftBill({
      orderId: po.id,
      supplierStatedTotal: '5900.00',
      lines: [billLine('100')],
    });
    expect(draft).toMatchObject({
      status: 'DRAFT',
      basis: 'PURCHASE_ORDER',
      invoiceNumber: null,
      grandTotal: '5900.00',
      cgstAmount: '450.00',
      dueDate: '2026-11-05', // supplier credit days: 30
      payableStatus: null,
    });

    const posted = await p.postBill(draft);
    expect(posted).toMatchObject({
      status: 'POSTED',
      postingDate: TODAY,
      matchStatus: 'MATCHED',
      matchFindings: [],
      paidAmount: '0.00',
      outstandingAmount: '5900.00',
      payableStatus: 'UNPAID',
      isOverdue: false,
      postedByName: fx.actors.accountant.user.displayName,
    });
    expect(posted.invoiceNumber).toMatch(/^PI\/26-27\/\d{5}$/);
    expect(await ledgerOf(posted.id)).toEqual([
      {
        entryType: 'PURCHASE_INVOICE',
        debit: '0.00',
        credit: '5900.00',
        entryDate: TODAY,
        partyId: fx.suppliers.local.id,
      },
    ]);

    const order = await qry().execute(getPurchaseOrder, { orderId: po.id }, fx.actors.owner);
    expect(order.lines[0]?.invoicedQuantity).toBe('100.000');
    expect(order.invoices).toEqual([
      {
        id: posted.id,
        invoiceNumber: posted.invoiceNumber,
        supplierInvoiceNumber: posted.supplierInvoiceNumber,
        status: 'POSTED',
      },
    ]);
  });

  it('bills one order in parts; the match counts what earlier bills already covered', async () => {
    const po = await orderWithReceipt('100');
    const first = await p.postBill(
      await p.draftBill({
        orderId: po.id,
        supplierStatedTotal: '2360.00',
        lines: [billLine('40')],
      }),
    );
    expect(first.matchStatus).toBe('MATCHED');
    const second = await p.draftBill({
      orderId: po.id,
      supplierStatedTotal: '4130.00',
      lines: [billLine('70')],
    });
    const m = await qry().execute(matchPurchaseInvoice, { invoiceId: second.id }, fx.actors.owner);
    expect(m.findings).toMatchObject([
      { code: 'QTY_EXCEEDS_RECEIVED', expected: '100.000', actual: '110.000' },
    ]);
    expect(m.matchStatus).toBe('ACCEPTED_WITH_DIFFERENCES');
  });

  it('names the delivery it covers, but only one of its own order', async () => {
    const po = await orderWithReceipt('0');
    const grn = await p.receive(po.id, [{ orderLineNo: 1, acceptedQuantity: '10' }]);
    const other = await orderWithReceipt('5');
    const bill = await p.draftBill({
      orderId: po.id,
      goodsReceiptId: grn.id,
      supplierStatedTotal: '590.00',
      lines: [billLine('10')],
    });
    expect(bill).toMatchObject({ goodsReceiptId: grn.id, grnNumber: grn.grnNumber });
    const otherGrn = (await qry().execute(getPurchaseOrder, { orderId: other.id }, fx.actors.owner))
      .receipts[0];
    await expect(
      p.draftBill({
        orderId: po.id,
        goodsReceiptId: otherGrn?.id,
        supplierStatedTotal: '590.00',
        lines: [billLine('10')],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('three-way match on posting', () => {
  it('refuses a bill for more than was received; explains why; only an override with a reason posts it', async () => {
    const po = await orderWithReceipt('60');
    const draft = await p.draftBill({
      orderId: po.id,
      supplierStatedTotal: '5900.00',
      lines: [billLine('100')],
    });
    const m = await qry().execute(matchPurchaseInvoice, { invoiceId: draft.id }, fx.actors.owner);
    expect(m).toMatchObject({
      status: 'DRAFT',
      basis: 'PURCHASE_ORDER',
      computedTotal: '5900.00',
      tolerances: { qtyPercent: '0.000', pricePercent: '0.000', totalAmount: '1.00' },
      findings: [
        {
          code: 'QTY_EXCEEDS_RECEIVED',
          invoiceLineNo: 1,
          orderLineNo: 1,
          expected: '60.000',
          actual: '100.000',
        },
      ],
    });

    await expect(p.postBill(draft)).rejects.toMatchObject({
      rule: 'THREE_WAY_MATCH_FAILED',
    });
    // The accountant may post matching bills, but may not wave differences through.
    await expect(
      p.postBill(draft, { reason: 'Supplier will send the rest' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await ledgerOf(draft.id)).toEqual([]);

    const posted = await p.postBill(draft, {
      actor: fx.actors.owner,
      reason: 'Balance 40 kg in transit; agreed with supplier',
    });
    expect(posted).toMatchObject({
      status: 'POSTED',
      matchStatus: 'ACCEPTED_WITH_DIFFERENCES',
      matchOverrideReason: 'Balance 40 kg in transit; agreed with supplier',
      matchFindings: [{ code: 'QTY_EXCEEDS_RECEIVED' }],
    });
    const after = await qry().execute(
      matchPurchaseInvoice,
      { invoiceId: draft.id },
      fx.actors.owner,
    );
    expect(after).toMatchObject({ status: 'POSTED', matchStatus: 'ACCEPTED_WITH_DIFFERENCES' });
  });

  it('detects a higher price, a different item, a charge not on the order and a wrong total', async () => {
    const po = await orderWithReceipt('100');
    const draft = await p.draftBill({
      orderId: po.id,
      supplierStatedTotal: '9999.00',
      lines: [
        billLine('100', '52'),
        { itemId: fx.items.carton.id, orderLineNo: null, quantity: '1', unitRate: '100' },
      ],
    });
    const m = await qry().execute(matchPurchaseInvoice, { invoiceId: draft.id }, fx.actors.owner);
    expect(m.findings.map((f) => f.code)).toEqual([
      'PRICE_ABOVE_ORDER',
      'NOT_ON_ORDER',
      'TOTAL_MISMATCH',
    ]);

    const wrongItem = await p.draftBill({
      orderId: po.id,
      supplierStatedTotal: '5900.00',
      lines: [{ itemId: fx.items.carton.id, orderLineNo: 1, quantity: '100', unitRate: '50' }],
    });
    const m2 = await qry().execute(
      matchPurchaseInvoice,
      { invoiceId: wrongItem.id },
      fx.actors.owner,
    );
    expect(m2.findings.map((f) => f.code)).toContain('ITEM_MISMATCH');
  });

  it('two bills for the same received goods, posted at once: the second sees the first', async () => {
    const po = await orderWithReceipt('100');
    const drafts = await Promise.all(
      [1, 2].map(() =>
        p.draftBill({ orderId: po.id, supplierStatedTotal: '5900.00', lines: [billLine('100')] }),
      ),
    );
    const results = await Promise.allSettled(drafts.map((d) => p.postBill(d)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      rule: 'THREE_WAY_MATCH_FAILED',
    });
    const order = await qry().execute(getPurchaseOrder, { orderId: po.id }, fx.actors.owner);
    expect(order.lines[0]?.invoicedQuantity).toBe('100.000');
  });
});

describe('direct (non-PO) bills', () => {
  it('posts with only the total checked; order lines and GRNs cannot be named', async () => {
    const draft = await p.draftBill({
      supplierStatedTotal: '590.00',
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: '10', unitRate: '50' }],
    });
    expect(draft.basis).toBe('DIRECT');
    const posted = await p.postBill(draft);
    expect(posted).toMatchObject({ matchStatus: 'NOT_APPLICABLE', outstandingAmount: '590.00' });

    await expect(
      p.draftBill({ supplierStatedTotal: '590.00', lines: [billLine('10')] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const off = await p.draftBill({
      supplierStatedTotal: '600.00',
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: '10', unitRate: '50' }],
    });
    await expect(p.postBill(off)).rejects.toMatchObject({ rule: 'THREE_WAY_MATCH_FAILED' });
  });

  it('charges IGST for a supplier in another state', async () => {
    const draft = await p.draftBill({
      supplierId: fx.suppliers.outstation.id,
      supplierStatedTotal: '1180.00',
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: '10', unitRate: '100' }],
    });
    expect(draft).toMatchObject({ supplyType: 'INTER_STATE', igstAmount: '180.00' });
  });
});

describe('guards', () => {
  it('refuses a bill against another supplier’s order or an unapproved order', async () => {
    const po = await orderWithReceipt('10');
    await expect(
      p.draftBill({
        supplierId: fx.suppliers.outstation.id,
        orderId: po.id,
        supplierStatedTotal: '590.00',
        lines: [billLine('10')],
      }),
    ).rejects.toMatchObject({ rule: 'ORDER_SUPPLIER_MISMATCH' });
    const draftPo = await p.draftPo();
    await expect(
      p.draftBill({ orderId: draftPo.id, supplierStatedTotal: '590.00', lines: [billLine('10')] }),
    ).rejects.toMatchObject({ rule: 'PURCHASE_ORDER_NOT_BILLABLE' });
  });

  it('catches the same supplier bill entered twice (spacing and case ignored)', async () => {
    const line = { itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '50' };
    await p.draftBill({
      supplierInvoiceNumber: 'abc/77',
      supplierStatedTotal: '59.00',
      lines: [line],
    });
    await expect(
      p.draftBill({
        supplierInvoiceNumber: ' ABC / 77',
        supplierStatedTotal: '59.00',
        lines: [line],
      }),
    ).rejects.toMatchObject({ rule: 'DUPLICATE_SUPPLIER_INVOICE' });
    // The same number from a different supplier is a different bill.
    await p.draftBill({
      supplierId: fx.suppliers.outstation.id,
      supplierInvoiceNumber: 'ABC/77',
      supplierStatedTotal: '59.00',
      lines: [line],
    });
  });

  it('refuses future-dated bills and posts an older bill after a newer one', async () => {
    const line = { itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '50' };
    await expect(
      p.draftBill({ invoiceDate: '2026-10-07', supplierStatedTotal: '59.00', lines: [line] }),
    ).rejects.toMatchObject({ rule: 'INVOICE_DATE_IN_FUTURE' });
    // Our number follows the posting date, so a late-arriving bill is not blocked.
    const old = await p.draftBill({
      invoiceDate: '2026-09-01',
      supplierStatedTotal: '59.00',
      lines: [line],
    });
    const posted = await p.postBill(old);
    expect(posted).toMatchObject({ postingDate: TODAY, invoiceDate: '2026-09-01' });
    expect(posted.isOverdue).toBe(true); // due 2026-10-01, unpaid
  });

  it('a posted bill is immutable — in the command and in SQL; the ledger is append-only', async () => {
    const posted = await p.postedBillFor([p.steel('10', '50')]);
    await expect(p.postBill(posted)).rejects.toMatchObject({ rule: 'PURCHASE_INVOICE_POSTED' });
    const db = env.services.db;
    await expect(
      sql`update purchase.invoices set grand_total = 1 where id = ${posted.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`update purchase.invoice_lines set quantity = 1 where invoice_id = ${posted.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`delete from purchase.invoices where id = ${posted.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`update finance.payable_ledger_entries set credit = 1 where source_id = ${posted.id}`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it('drafting and posting are separate permissions; the AI may only draft', async () => {
    const line = { itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '50' };
    const byPurchase = await p.draftBill(
      { supplierStatedTotal: '59.00', lines: [line] },
      { actor: fx.actors.purchase },
    );
    await expect(p.postBill(byPurchase, { actor: fx.actors.purchase })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      p.draftBill({ supplierStatedTotal: '59.00', lines: [line] }, { actor: fx.actors.supervisor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const byAi = await p.draftBill(
      { supplierStatedTotal: '59.00', lines: [line] },
      { actor: asAiAgent(fx.actors.owner) },
    );
    expect(byAi.status).toBe('DRAFT');
    await expect(p.postBill(byAi, { actor: asAiAgent(fx.actors.owner) })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a retried post (same Idempotency-Key) posts once and owes once', async () => {
    const draft = await p.draftBill({
      supplierStatedTotal: '59.00',
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '50' }],
    });
    const once = await p.postBill(draft, { key: 'pi-post-1' });
    const twice = await p.postBill(draft, { key: 'pi-post-1' });
    expect(twice).toEqual(once);
    expect(await ledgerOf(draft.id)).toHaveLength(1);
    await expect(
      env.services.commands.execute(
        postPurchaseInvoice,
        { invoiceId: draft.id, expectedVersion: draft.version },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

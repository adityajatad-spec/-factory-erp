import type { PurchaseInvoiceDto, SupplierPaymentDto } from '@factory-erp/contracts';
import { Dec, Money } from '@factory-erp/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { purchaseFlows } from '../../../test/purchase-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { AuthenticatedActor } from '../../platform/actor';
import { ForbiddenError, VersionConflictError } from '../../platform/errors';
import { getDashboard } from '../analytics';
import { listStock } from '../inventory';
import {
  allocateSupplierPayment,
  approveSupplierPayment,
  getPayablesSummary,
  listOpenPayables,
  listSupplierPayments,
  rejectSupplierPayment,
  requestSupplierPayment,
} from './index';

const TODAY = '2026-10-07';
let env: TestEnv;
let fx: Fixture;
const p = purchaseFlows(
  () => env,
  () => fx,
  TODAY,
);
const cmd = () => env.services.commands;
const qry = () => env.services.queries;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

function request(
  amount: string,
  allocations: Array<{ purchaseInvoiceId: string; amount: string }> = [],
  opts: { actor?: AuthenticatedActor; key?: string; supplierId?: string } = {},
): Promise<SupplierPaymentDto> {
  return cmd().execute(
    requestSupplierPayment,
    {
      supplierId: opts.supplierId ?? fx.suppliers.local.id,
      paymentDate: TODAY,
      amount,
      paymentMode: 'BANK_TRANSFER',
      reference: 'NEFT-TEST',
      allocations,
    },
    opts.actor ?? fx.actors.accountant,
    opts.key ? { idempotencyKey: opts.key } : {},
  );
}
const approve = (
  pay: SupplierPaymentDto,
  opts: { actor?: AuthenticatedActor; key?: string } = {},
): Promise<SupplierPaymentDto> =>
  cmd().execute(
    approveSupplierPayment,
    { paymentId: pay.id, expectedVersion: pay.version },
    opts.actor ?? fx.actors.owner,
    opts.key ? { idempotencyKey: opts.key } : {},
  );
const pay = async (
  amount: string,
  allocations: Array<{ purchaseInvoiceId: string; amount: string }> = [],
) => approve(await request(amount, allocations));
const allocate = (
  paymentId: string,
  allocations: Array<{ purchaseInvoiceId: string; amount: string }>,
) => cmd().execute(allocateSupplierPayment, { paymentId, allocations }, fx.actors.accountant);
const owedOn = (bill: PurchaseInvoiceDto) => p.bill(bill.id);
/** A posted direct bill of `qty` kg @ ₹50 (₹59 a kg with GST) dated `date`. */
const directBill = async (qty: string, date = TODAY, supplierId = fx.suppliers.local.id) =>
  p.postBill(
    await p.draftBill({
      supplierId,
      invoiceDate: date,
      supplierStatedTotal: new Dec(qty).times(59).toFixed(2),
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: qty, unitRate: '50' }],
    }),
  );

describe('procure-to-pay, end to end', () => {
  it('supplier → PO → approval → GRN → stock → bill → payable → payment → allocation → nothing owed', async () => {
    const stock = async () =>
      (
        await qry().execute(
          listStock,
          { itemId: fx.items.rawMaterial.id, warehouseId: fx.warehouse.id, includeZero: 'true' },
          fx.actors.owner,
        )
      )[0]?.quantity ?? '0.000';
    const stockBefore = await stock();
    const bill = await p.postedBillFor([p.steel('100', '50')]);
    expect(new Dec(await stock()).minus(stockBefore).toString()).toBe('100');
    expect(bill).toMatchObject({ grandTotal: '5900.00', payableStatus: 'UNPAID' });

    const requested = await request('5900.00', [{ purchaseInvoiceId: bill.id, amount: '5900.00' }]);
    expect(requested).toMatchObject({
      status: 'PENDING_APPROVAL',
      paymentNumber: null,
      allocatedAmount: '0.00',
      proposedAllocations: [{ purchaseInvoiceId: bill.id, invoiceNumber: bill.invoiceNumber }],
    });
    // Nothing changes until a second person approves.
    expect((await owedOn(bill)).outstandingAmount).toBe('5900.00');

    const approved = await approve(requested);
    expect(approved).toMatchObject({
      status: 'APPROVED',
      allocatedAmount: '5900.00',
      unallocatedAmount: '0.00',
      approvedByName: fx.actors.owner.user.displayName,
      requestedByName: fx.actors.accountant.user.displayName,
    });
    expect(approved.paymentNumber).toMatch(/^PAY\/26-27\/\d{5}$/);
    expect(await owedOn(bill)).toMatchObject({
      outstandingAmount: '0.00',
      paidAmount: '5900.00',
      payableStatus: 'PAID',
      payments: [{ paymentId: approved.id, amount: '5900.00' }],
    });
    const ledger = await env.services.db
      .selectFrom('finance.payableLedgerEntries')
      .select(['entryType', 'debit', 'credit'])
      .where('sourceId', 'in', [bill.id, approved.id])
      .orderBy('entryType')
      .execute();
    expect(ledger).toEqual([
      { entryType: 'PURCHASE_INVOICE', debit: '0.00', credit: '5900.00' },
      { entryType: 'SUPPLIER_PAYMENT', debit: '5900.00', credit: '0.00' },
    ]);
  });
});

describe('payments and allocation', () => {
  it('partial payment, then the rest; one payment across several bills', async () => {
    const b1 = await directBill('100');
    const b2 = await directBill('20');
    await pay('2000.00', [{ purchaseInvoiceId: b1.id, amount: '2000.00' }]);
    expect(await owedOn(b1)).toMatchObject({
      outstandingAmount: '3900.00',
      payableStatus: 'PARTIALLY_PAID',
    });
    const both = await pay('5080.00', [
      { purchaseInvoiceId: b1.id, amount: '3900.00' },
      { purchaseInvoiceId: b2.id, amount: '1180.00' },
    ]);
    expect(both.allocations).toHaveLength(2);
    expect((await owedOn(b1)).payableStatus).toBe('PAID');
    expect((await owedOn(b2)).payableStatus).toBe('PAID');
  });

  it('keeps money on account and allocates it to a later bill', async () => {
    const b = await directBill('10'); // 590.00
    const advance = await pay('1000.00', [{ purchaseInvoiceId: b.id, amount: '590.00' }]);
    expect(advance).toMatchObject({ allocatedAmount: '590.00', unallocatedAmount: '410.00' });
    const later = await directBill('5'); // 295.00
    const after = await allocate(advance.id, [{ purchaseInvoiceId: later.id, amount: '295.00' }]);
    expect(after.unallocatedAmount).toBe('115.00');
    expect((await owedOn(later)).payableStatus).toBe('PAID');
    const onAccount = await qry().execute(
      listSupplierPayments,
      { onlyUnallocated: 'true' },
      fx.actors.owner,
    );
    expect(onAccount.map((x) => x.id)).toContain(advance.id);
  });

  it('never over-allocates a bill or a payment, and a request is refused whole', async () => {
    const b = await directBill('10'); // 590.00
    await expect(
      request('1000.00', [{ purchaseInvoiceId: b.id, amount: '590.01' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    await expect(
      request('100.00', [{ purchaseInvoiceId: b.id, amount: '200.00' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_PAYMENT_AVAILABLE' });
    const other = await directBill('1', TODAY, fx.suppliers.outstation.id);
    await expect(
      request('100.00', [{ purchaseInvoiceId: other.id, amount: '10.00' }]),
    ).rejects.toMatchObject({ rule: 'SUPPLIER_MISMATCH' });
    const draft = await p.draftBill({
      supplierStatedTotal: '59.00',
      lines: [{ itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '50' }],
    });
    await expect(
      request('59.00', [{ purchaseInvoiceId: draft.id, amount: '59.00' }]),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_POSTED' });
  });

  it('re-checks proposed allocations on approval, under lock, all or nothing', async () => {
    const b = await directBill('10'); // 590.00
    const first = await request('590.00', [{ purchaseInvoiceId: b.id, amount: '590.00' }]);
    const second = await request('590.00', [{ purchaseInvoiceId: b.id, amount: '590.00' }]);
    await approve(first);
    await expect(approve(second)).rejects.toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    const still = await qry().execute(
      listSupplierPayments,
      { status: 'PENDING_APPROVAL' },
      fx.actors.owner,
    );
    expect(still.map((x) => x.id)).toContain(second.id);
    const rejected = await cmd().execute(
      rejectSupplierPayment,
      { paymentId: second.id, expectedVersion: second.version, reason: 'Duplicate of first' },
      fx.actors.owner,
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'Duplicate of first' });
    await expect(approve(rejected)).rejects.toMatchObject({
      rule: 'SUPPLIER_PAYMENT_NOT_PENDING',
    });
    await expect(
      allocate(rejected.id, [{ purchaseInvoiceId: b.id, amount: '1.00' }]),
    ).rejects.toMatchObject({ rule: 'SUPPLIER_PAYMENT_NOT_APPROVED' });
  });
});

describe('maker-checker', () => {
  it('whoever recorded a payment cannot approve it — in the command and in SQL', async () => {
    const own = await request('100.00', [], { actor: fx.actors.owner });
    await expect(approve(own, { actor: fx.actors.owner })).rejects.toMatchObject({
      rule: 'SELF_APPROVAL',
    });
    const ok = await approve(own, { actor: fx.actors.admin });
    expect(ok.approvedByName).toBe(fx.actors.admin.user.displayName);

    const viaSql = await request('100.00', [], { actor: fx.actors.owner });
    await expect(
      sql`update finance.supplier_payments
             set status = 'APPROVED', approved_at = now(), approved_by = requested_by,
                 payment_number = 'RAW/1', fiscal_year = '2026-27'
           where id = ${viaSql.id}`.execute(env.services.db),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the requester cannot approve without the permission; the AI cannot pay at all', async () => {
    const r = await request('50.00');
    await expect(approve(r, { actor: fx.actors.accountant })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(request('50.00', [], { actor: fx.actors.purchase })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      request('50.00', [], { actor: asAiAgent(fx.actors.owner) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('SQL keeps payments and allocations honest (immutability, deferred settlement check)', async () => {
    const pending = await request('75.00');
    const db = env.services.db;
    await expect(
      sql`update finance.supplier_payments set amount = 1 where id = ${pending.id}`.execute(db),
    ).rejects.toMatchObject({ code: 'FO002' });
    const b = await directBill('1');
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`insert into finance.supplier_payment_allocations
                    (id, company_id, payment_id, purchase_invoice_id, amount, allocated_at, allocated_by)
                  values (gen_random_uuid(), ${fx.companyId}, ${pending.id}, ${b.id}, 1, now(),
                          ${fx.actors.owner.user.id})`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: 'FO005' });
    const approved = await approve(pending);
    await expect(
      sql`update finance.supplier_payments set status = 'REJECTED' where id = ${approved.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
  });
});

describe('concurrency and idempotency', () => {
  it('two on-account payments settling the same bill at once: exactly one wins', async () => {
    const [x, y] = await Promise.all([pay('590.00'), pay('590.00')]);
    const b = await directBill('10'); // 590.00
    const results = await Promise.allSettled(
      [x, y].map((pm) => allocate(pm.id, [{ purchaseInvoiceId: b.id, amount: '590.00' }])),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await owedOn(b)).paidAmount).toBe('590.00');
  });

  it('one payment allocated twice at once cannot be spent twice', async () => {
    const pm = await pay('600.00');
    const [b1, b2] = [await directBill('10'), await directBill('10')];
    const results = await Promise.allSettled([
      allocate(pm.id, [{ purchaseInvoiceId: b1.id, amount: '590.00' }]),
      allocate(pm.id, [{ purchaseInvoiceId: b2.id, amount: '590.00' }]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a payment approved twice at once is approved once', async () => {
    const r = await request('42.00');
    const results = await Promise.allSettled([
      approve(r, { actor: fx.actors.owner }),
      approve(r, { actor: fx.actors.admin }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(VersionConflictError);
    const ledger = await env.services.db
      .selectFrom('finance.payableLedgerEntries')
      .select('id')
      .where('sourceId', '=', r.id)
      .execute();
    expect(ledger).toHaveLength(1);
  });

  it('retried request and approval (same Idempotency-Key) record one payment, debited once', async () => {
    const once = await request('33.00', [], { key: 'spay-req-1' });
    const twice = await request('33.00', [], { key: 'spay-req-1' });
    expect(twice).toEqual(once);
    const a1 = await approve(once, { key: 'spay-app-1' });
    const a2 = await approve(once, { key: 'spay-app-1' });
    expect(a2).toEqual(a1);
    const rows = await env.services.db
      .selectFrom('finance.payableLedgerEntries')
      .select('id')
      .where('sourceId', '=', once.id)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('what we owe', () => {
  it('answers: owed per supplier, unpaid, overdue, due this week, paid and on account — and reconciles', async () => {
    const overdue = await directBill('2', '2026-09-01'); // due 2026-10-01
    const dueSoon = await directBill('3', '2026-09-08'); // due 2026-10-08
    const open = await qry().execute(listOpenPayables, {}, fx.actors.accountant);
    expect(open.map((o) => o.purchaseInvoiceId)).toEqual(
      expect.arrayContaining([overdue.id, dueSoon.id]),
    );
    const late = await qry().execute(listOpenPayables, { overdue: 'true' }, fx.actors.accountant);
    expect(late.find((o) => o.purchaseInvoiceId === overdue.id)).toMatchObject({
      isOverdue: true,
      daysOverdue: 6,
    });
    expect(late.map((o) => o.purchaseInvoiceId)).not.toContain(dueSoon.id);
    const week = await qry().execute(listOpenPayables, { dueWithinDays: 7 }, fx.actors.accountant);
    expect(week.map((o) => o.purchaseInvoiceId)).toContain(dueSoon.id);
    expect(week.map((o) => o.purchaseInvoiceId)).not.toContain(overdue.id);

    const s = await qry().execute(getPayablesSummary, {}, fx.actors.accountant);
    const local = s.suppliers.find((x) => x.supplierId === fx.suppliers.local.id);
    expect(local).toBeDefined();
    const t = s.totals;
    // balance (ledger) = Σ bill-wise outstanding − Σ money on account
    expect(t.balance).toBe(
      Money.of(t.outstandingAmount).minus(Money.of(t.unallocatedAmount)).toString(),
    );
    expect(Money.of(local!.overdueAmount).compare(Money.of('118.00'))).toBeGreaterThanOrEqual(0);
    expect(Money.of(local!.dueThisWeekAmount).compare(Money.of('177.00'))).toBeGreaterThanOrEqual(
      0,
    );

    const dash = await qry().execute(getDashboard, {}, fx.actors.owner);
    const kpi = (id: string) => dash.kpis.find((k) => k.id === id)?.value;
    expect(kpi('finance.payables_outstanding')).toBe(t.balance);
    expect(kpi('finance.payables_overdue')).toBe(t.overdueAmount);
    expect(kpi('finance.payables_due_this_week')).toBe(t.dueThisWeekAmount);
  });
});

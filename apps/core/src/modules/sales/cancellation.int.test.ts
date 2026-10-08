import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { salesFlows } from '../../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { listAuditEvents } from '../audit/queries';
import { getDashboard } from '../analytics/dashboard';
import { listOpenInvoices } from '../receivables/queries';
import { allocateReceipt } from '../receivables/commands';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { createInvoiceDraft } from './draft-commands';
import { listInvoices } from './queries';

const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);

beforeAll(async () => {
  env = await createTestEnv({ clock: '2026-10-05T09:30:00Z' });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const db = () => env.services.db;

describe('cancelling an issued invoice', () => {
  it('keeps the invoice, its number and values; records who, when and why; reverses the balance', async () => {
    const balanceBefore = await f.ledgerBalance(fx.customers.intra.id);
    const inv = await f.issued('8474.58'); // ₹10,000.00
    expect(await f.ledgerBalance(fx.customers.intra.id)).toBe(
      f.money(String(Number(balanceBefore) + 10000)),
    );

    const cancelled = await f.cancel(inv, { reason: 'Duplicate of an earlier invoice' });
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      invoiceNumber: inv.invoiceNumber,
      grandTotal: '10000.00',
      totals: inv.totals,
      version: inv.version + 1,
      paymentStatus: null,
      outstandingAmount: null,
      cancellation: { reason: 'Duplicate of an earlier invoice', cancelledByName: 'accountant' },
    });
    expect(cancelled.cancellation?.cancelledAt).toBe('2026-10-05T09:30:00.000Z');
    expect(cancelled.lines).toEqual(inv.lines);

    // Ledger: the original debit stays; a new reversing credit is appended.
    const ledger = await f.ledgerOf(inv.id);
    expect(ledger.map((l) => [l.entryType, l.debit, l.credit])).toEqual([
      ['SALES_INVOICE', '10000.00', '0.00'],
      ['INVOICE_CANCELLATION', '0.00', '10000.00'],
    ]);
    expect(await f.ledgerBalance(fx.customers.intra.id)).toBe(balanceBefore);
  });

  it('D: a cancelled unpaid invoice no longer counts as a receivable anywhere', async () => {
    const inv = await f.issued('100', { customer: fx.customers.inter }); // IGST, ₹118.00
    const before = await f.summary();
    const kpis = async () =>
      Object.fromEntries(
        (await env.services.queries.execute(getDashboard, {}, fx.actors.accountant)).kpis.map(
          (k) => [k.id, k.value],
        ),
      );
    const kpiBefore = await kpis();

    await f.cancel(inv);

    const open = await env.services.queries.execute(
      listOpenInvoices,
      { customerId: fx.customers.inter.id },
      fx.actors.accountant,
    );
    expect(open.map((o) => o.invoiceId)).not.toContain(inv.id);
    const after = await f.summary();
    expect(Number(after.totals.outstandingAmount)).toBeCloseTo(
      Number(before.totals.outstandingAmount) - 118,
      2,
    );
    expect(Number(after.totals.balance)).toBeCloseTo(Number(before.totals.balance) - 118, 2);
    const kpiAfter = await kpis();
    expect(Number(kpiAfter['sales.today'])).toBeCloseTo(Number(kpiBefore['sales.today']) - 118, 2);
    expect(Number(kpiAfter['sales.invoices_this_month'])).toBe(
      Number(kpiBefore['sales.invoices_this_month']) - 1,
    );
    expect(Number(kpiAfter['finance.receivables_outstanding'])).toBeCloseTo(
      Number(kpiBefore['finance.receivables_outstanding']) - 118,
      2,
    );
    // Reconciliation still holds for every customer.
    for (const c of after.customers) {
      expect(f.money(c.balance)).toBe(
        f.money(String(Number(c.outstandingAmount) - Number(c.unallocatedAmount))),
      );
    }
  });

  it('lists cancelled invoices under their own status, never under a payment status', async () => {
    const inv = await f.issued('10');
    await f.cancel(inv);
    const q = (input: Record<string, string>) =>
      env.services.queries.execute(listInvoices, input, fx.actors.accountant);
    expect((await q({ status: 'CANCELLED' })).map((i) => i.id)).toContain(inv.id);
    for (const payment of ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'CREDITED']) {
      expect((await q({ paymentStatus: payment })).map((i) => i.id)).not.toContain(inv.id);
    }
  });
});

describe('cancellation is rejected when it would break history or balances', () => {
  it('E: rejects cancelling twice', async () => {
    const inv = await f.issued('100');
    const cancelled = await f.cancel(inv);
    await expect(f.cancel(cancelled)).rejects.toMatchObject({ rule: 'INVOICE_ALREADY_CANCELLED' });
    await expect(f.cancel(inv)).rejects.toMatchObject({ rule: 'INVOICE_ALREADY_CANCELLED' });
    expect(
      (await f.ledgerOf(inv.id)).filter((l) => l.entryType === 'INVOICE_CANCELLATION'),
    ).toHaveLength(1);
  });

  it('rejects drafts (they are deleted, not cancelled), unknown invoices and stale versions', async () => {
    const draft = await env.services.commands.execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '10' }],
      },
      fx.actors.accountant,
    );
    await expect(f.cancel(draft)).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
    await expect(f.cancel({ ...draft, id: uuidv7() })).rejects.toBeInstanceOf(NotFoundError);

    const inv = await f.issued('100');
    await expect(f.cancel(inv, { version: inv.version - 1 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    await expect(f.cancel(inv, { reason: ' x ' })).rejects.toBeInstanceOf(ValidationError);
    expect((await f.invoice(inv.id)).status).toBe('ISSUED');
  });

  it('rejects an invoice with payments allocated (no silent refund) — and changes nothing', async () => {
    const inv = await f.issued('100'); // 118
    await f.receipt('50.00', [{ invoiceId: inv.id, amount: '50.00' }]);
    const ledgerRows = await f.count('finance.partyLedgerEntries');
    await expect(f.cancel(await f.invoice(inv.id))).rejects.toMatchObject({
      rule: 'INVOICE_HAS_PAYMENTS',
    });
    expect(await f.count('finance.partyLedgerEntries')).toBe(ledgerRows);
    expect(await f.invoice(inv.id)).toMatchObject({
      status: 'ISSUED',
      paidAmount: '50.00',
      outstandingAmount: '68.00',
    });
  });

  it('rejects an invoice with an issued credit note', async () => {
    const inv = await f.issued('8474.58');
    await f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '1694.92' }]);
    await expect(f.cancel(await f.invoice(inv.id))).rejects.toMatchObject({
      rule: 'INVOICE_HAS_CREDIT_NOTES',
    });
  });

  it('no payment can be allocated to a cancelled invoice afterwards', async () => {
    const inv = await f.issued('100');
    await f.cancel(inv);
    await expect(
      f.receipt('118.00', [{ invoiceId: inv.id, amount: '118.00' }]),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
  });
});

describe('database defence in depth', () => {
  it('cancelled invoices are immutable: values, status and cancellation details', async () => {
    const inv = await f.cancel(await f.issued('100'));
    const attempt = (set: string) =>
      sql`update sales.invoices set ${sql.raw(set)} where id = ${inv.id}`.execute(db());
    await expect(attempt('grand_total = 1')).rejects.toMatchObject({ code: 'FO002' });
    await expect(attempt(`status = 'ISSUED'`)).rejects.toMatchObject({ code: 'FO002' });
    await expect(attempt(`cancellation_reason = 'changed later'`)).rejects.toMatchObject({
      code: 'FO002',
    });
    await expect(attempt(`cancelled_at = now() - interval '1 day'`)).rejects.toMatchObject({
      code: 'FO002',
    });
    await expect(
      sql`delete from sales.invoices where id = ${inv.id}`.execute(db()),
    ).rejects.toMatchObject({ code: 'FO002' });
    const deleteLedger = sql`delete from finance.party_ledger_entries where source_id = ${inv.id}`;
    await expect(deleteLedger.execute(db())).rejects.toMatchObject({ code: '42501' });
    await expect(deleteLedger.execute(env.ownerDb)).rejects.toMatchObject({ code: 'FO001' });
  });

  it('SQL alone cannot cancel a paid invoice, cancel a draft, or cancel without details', async () => {
    const paid = await f.issued('100');
    await f.receipt('118.00', [{ invoiceId: paid.id, amount: '118.00' }]);
    await expect(
      sql`update sales.invoices set status = 'CANCELLED', cancelled_at = now(), cancelled_by = ${fx.actors.owner.user.id}, cancellation_reason = 'sql' where id = ${paid.id}`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ code: 'FO002' });

    const unpaid = await f.issued('100');
    await expect(
      sql`update sales.invoices set status = 'CANCELLED' where id = ${unpaid.id}`.execute(db()),
    ).rejects.toMatchObject({ code: '23514' }); // CHECK: who/when/why are mandatory

    const draft = await env.services.commands.execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '10' }],
      },
      fx.actors.accountant,
    );
    await expect(
      sql`update sales.invoices set status = 'CANCELLED', cancelled_at = now(), cancelled_by = ${fx.actors.owner.user.id}, cancellation_reason = 'sql' where id = ${draft.id}`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
  });
});

describe('concurrency, idempotency, permissions and audit', () => {
  it('a payment and a cancellation racing on one invoice: exactly one wins', async () => {
    const inv = await f.issued('100');
    const r = await f.receipt('118.00');
    const outcomes = await Promise.allSettled([
      f.cancel(inv),
      env.services.commands.execute(
        allocateReceipt,
        { receiptId: r.id, allocations: [{ invoiceId: inv.id, amount: '118.00' }] },
        fx.actors.accountant,
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(BusinessRuleError);
    const final = await f.invoice(inv.id);
    // Either cancelled with nothing paid, or still issued and fully paid — never both.
    expect(
      (final.status === 'CANCELLED' && final.paidAmount === '0.00') ||
        (final.status === 'ISSUED' && final.paymentStatus === 'PAID'),
    ).toBe(true);
  });

  it('replays a repeated Idempotency-Key instead of cancelling (or reversing) twice', async () => {
    const inv = await f.issued('100');
    const key = `cancel-${uuidv7()}`;
    const first = await f.cancel(inv, { key });
    const again = await f.cancel(inv, { key });
    expect(again).toEqual(first);
    expect(
      (await f.ledgerOf(inv.id)).filter((l) => l.entryType === 'INVOICE_CANCELLATION'),
    ).toHaveLength(1);
  });

  it('only authorised humans can cancel — never a worker, never the AI', async () => {
    const inv = await f.issued('100');
    await expect(f.cancel(inv, { actor: fx.actors.worker })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.cancel(inv, { actor: asAiAgent(fx.actors.accountant) })).rejects.toThrow(
      /requires a human \(AI tier CONFIRM\)/,
    );
    expect((await f.invoice(inv.id)).status).toBe('ISSUED');
    expect((await f.cancel(inv, { actor: fx.actors.owner })).status).toBe('CANCELLED');
  });

  it('records the cancellation in the invoice history with the reason', async () => {
    const inv = await f.cancel(await f.issued('100'), { reason: 'Customer PO withdrawn' });
    const history = await env.services.queries.execute(
      listAuditEvents,
      { entityType: 'sales.invoice', entityId: inv.id },
      fx.actors.accountant,
    );
    // The test clock is frozen, so events share a timestamp: compare as a set.
    expect(history.map((h) => h.command).sort()).toEqual([
      'sales.invoice.cancel',
      'sales.invoice.createDraft',
      'sales.invoice.issue',
    ]);
    expect(history.find((h) => h.command === 'sales.invoice.cancel')?.summary).toBe(
      'Cancelled — Customer PO withdrawn (₹118.00 reversed from the customer balance)',
    );
    const raw = await db()
      .selectFrom('audit.events')
      .select(['before', 'after', 'actorKind'])
      .where('entityId', '=', inv.id)
      .where('command', '=', 'sales.invoice.cancel')
      .executeTakeFirstOrThrow();
    expect(raw).toMatchObject({
      actorKind: 'user',
      before: { status: 'ISSUED', outstandingAmount: '118.00' },
      after: { status: 'CANCELLED', reason: 'Customer PO withdrawn', reversedAmount: '118.00' },
    });
  });
});

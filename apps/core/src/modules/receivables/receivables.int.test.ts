import type {
  InvoiceDto,
  PartyDto,
  ReceiptDto,
  ReceivablesSummaryDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import {
  BusinessRuleError,
  ForbiddenError,
  IdempotencyKeyReusedError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { createParty } from '../parties/commands';
import { createInvoiceDraft } from '../sales/draft-commands';
import { issueInvoice } from '../sales/issue-command';
import { getInvoice, listInvoices } from '../sales/queries';
import { applyAllocations } from './allocate';
import { allocateReceipt, recordReceipt } from './commands';
import { getReceivablesSummary } from './summary';

// Business date fixed at 2026-10-05 (IST) so ageing and date rules are deterministic.
const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;

beforeAll(async () => {
  env = await createTestEnv({ clock: '2026-10-05T09:30:00Z' });
  fx = await createFixture(env.services);
  // Old invoices for the inter-state customer, issued first (the series is date-ordered).
  for (const date of ['2026-06-20', '2026-07-20', '2026-08-20', '2026-09-30']) {
    await issued('1000', date, fx.customers.inter);
  }
});
afterAll(async () => env.destroy());

const cmd = () => env.services.commands;

/** Issue a one-line invoice: unit rate × 1 widget @ 18% → total = rate × 1.18. */
async function issued(
  unitRate: string,
  date = TODAY,
  customer: PartyDto = fx.customers.intra,
): Promise<InvoiceDto> {
  const draft = await cmd().execute(
    createInvoiceDraft,
    {
      customerId: customer.id,
      invoiceDate: date,
      lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate }],
    },
    fx.actors.accountant,
  );
  return cmd().execute(
    issueInvoice,
    { invoiceId: draft.id, expectedVersion: draft.version },
    fx.actors.accountant,
  );
}

const invoice = (id: string) =>
  env.services.queries.execute(getInvoice, { invoiceId: id }, fx.actors.accountant);

function receipt(
  amount: string,
  allocations: Array<{ invoiceId: string; amount: string }> = [],
  customerId = fx.customers.intra.id,
  opts: { key?: string } = {},
) {
  return cmd().execute(
    recordReceipt,
    {
      customerId,
      receiptDate: TODAY,
      amount,
      paymentMode: 'BANK_TRANSFER',
      reference: 'UTR-TEST',
      allocations,
    },
    fx.actors.accountant,
    opts.key ? { idempotencyKey: opts.key } : {},
  );
}

const count = async (table: 'finance.receipts' | 'finance.receiptAllocations') =>
  Number(
    (
      await env.services.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe('recording receipts', () => {
  it('records an unallocated receipt: numbered, credited to the customer ledger, fully on account', async () => {
    const r = await receipt('500.00');
    expect(r.receiptNumber).toMatch(/^RCPT\/26-27\/\d{5}$/);
    expect(r).toMatchObject({
      amount: '500.00',
      allocatedAmount: '0.00',
      unallocatedAmount: '500.00',
      allocations: [],
    });
    const ledger = await env.services.db
      .selectFrom('finance.partyLedgerEntries')
      .selectAll()
      .where('sourceId', '=', r.id)
      .execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entryType: 'RECEIPT', credit: '500.00', debit: '0.00' });
  });

  it('full payment → PAID with zero outstanding (derived)', async () => {
    const inv = await issued('1000'); // 1180.00
    await receipt('1180.00', [{ invoiceId: inv.id, amount: '1180.00' }]);
    const after = await invoice(inv.id);
    expect(after).toMatchObject({
      paymentStatus: 'PAID',
      paidAmount: '1180.00',
      outstandingAmount: '0.00',
    });
    expect(after.payments).toHaveLength(1);
  });

  it('partial payments accumulate: UNPAID → PARTIALLY_PAID → PAID', async () => {
    const inv = await issued('500'); // 590.00
    expect((await invoice(inv.id)).paymentStatus).toBe('UNPAID');
    await receipt('200.00', [{ invoiceId: inv.id, amount: '200.00' }]);
    expect(await invoice(inv.id)).toMatchObject({
      paymentStatus: 'PARTIALLY_PAID',
      outstandingAmount: '390.00',
    });
    await receipt('390.00', [{ invoiceId: inv.id, amount: '390.00' }]);
    expect(await invoice(inv.id)).toMatchObject({
      paymentStatus: 'PAID',
      outstandingAmount: '0.00',
    });
  });

  it('allocates one receipt across several invoices and keeps the remainder unallocated', async () => {
    const a = await issued('1000'); // 1180
    const b = await issued('250'); // 295
    const r = await receipt('2000.00', [
      { invoiceId: a.id, amount: '1180.00' },
      { invoiceId: b.id, amount: '100.00' },
    ]);
    expect(r).toMatchObject({ allocatedAmount: '1280.00', unallocatedAmount: '720.00' });
    expect(r.allocations.map((x) => x.amount).sort()).toEqual(['100.00', '1180.00']);
    expect((await invoice(b.id)).outstandingAmount).toBe('195.00');

    // The remaining 720 can be allocated later (overpayment rule: kept on account until then).
    const later = await cmd().execute(
      allocateReceipt,
      { receiptId: r.id, allocations: [{ invoiceId: b.id, amount: '195.00' }] },
      fx.actors.accountant,
    );
    expect(later).toMatchObject({ allocatedAmount: '1475.00', unallocatedAmount: '525.00' });
    expect((await invoice(b.id)).paymentStatus).toBe('PAID');
  });
});

describe('allocation rules are enforced atomically', () => {
  it('rejects paying more than an invoice owes — and records nothing', async () => {
    const inv = await issued('100'); // 118
    const [receipts, allocations] = [
      await count('finance.receipts'),
      await count('finance.receiptAllocations'),
    ];
    await expect(
      receipt('500.00', [{ invoiceId: inv.id, amount: '118.01' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    expect(await count('finance.receipts')).toBe(receipts);
    expect(await count('finance.receiptAllocations')).toBe(allocations);
  });

  it('keeps receipt numbering gapless across a rejected receipt', async () => {
    const first = await receipt('10.00');
    await expect(receipt('1.00', [{ invoiceId: uuidv7(), amount: '1.00' }])).rejects.toBeInstanceOf(
      BusinessRuleError,
    );
    const next = await receipt('10.00');
    const seq = (n: string) => Number(n.split('/')[2]);
    expect(seq(next.receiptNumber)).toBe(seq(first.receiptNumber) + 1);
  });

  it('rejects allocations larger than the receipt', async () => {
    const a = await issued('1000');
    await expect(receipt('100.00', [{ invoiceId: a.id, amount: '100.01' }])).rejects.toMatchObject({
      rule: 'EXCEEDS_RECEIPT_AVAILABLE',
    });
  });

  it("rejects drafts and other customers' invoices", async () => {
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '10' }],
      },
      fx.actors.accountant,
    );
    await expect(
      receipt('100.00', [{ invoiceId: draft.id, amount: '1.00' }]),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
    const othersInvoice = (
      await env.services.queries.execute(
        listInvoices,
        { customerId: fx.customers.inter.id, status: 'ISSUED' },
        fx.actors.accountant,
      )
    )[0];
    await expect(
      receipt('100.00', [{ invoiceId: othersInvoice!.id, amount: '1.00' }]),
    ).rejects.toMatchObject({ rule: 'CUSTOMER_MISMATCH' });
  });

  it('rejects future-dated receipts and parties that are not customers', async () => {
    await expect(
      cmd().execute(
        recordReceipt,
        {
          customerId: fx.customers.intra.id,
          receiptDate: '2026-10-06',
          amount: '1',
          paymentMode: 'CASH',
        },
        fx.actors.accountant,
      ),
    ).rejects.toMatchObject({ rule: 'RECEIPT_DATE_IN_FUTURE' });
    const supplier = await cmd().execute(
      createParty,
      {
        code: 'S-ONLY',
        name: 'Supplier Only',
        isCustomer: false,
        isSupplier: true,
        stateCode: '27',
      },
      fx.actors.owner,
    );
    await expect(receipt('1.00', [], supplier.id)).rejects.toMatchObject({
      rule: 'NOT_AN_ACTIVE_CUSTOMER',
    });
  });

  it('only lets authorised roles record receipts (and never the AI)', async () => {
    await expect(
      cmd().execute(
        recordReceipt,
        { customerId: fx.customers.intra.id, receiptDate: TODAY, amount: '1', paymentMode: 'CASH' },
        fx.actors.worker,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cmd().execute(
        recordReceipt,
        { customerId: fx.customers.intra.id, receiptDate: TODAY, amount: '1', paymentMode: 'CASH' },
        { ...fx.actors.accountant, actorKind: 'ai_agent' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('idempotency and concurrency', () => {
  it('replays a receipt for a repeated Idempotency-Key instead of recording it twice', async () => {
    const before = await count('finance.receipts');
    const a = await receipt('75.00', [], fx.customers.intra.id, { key: 'receipt-key-0001' });
    const b = await receipt('75.00', [], fx.customers.intra.id, { key: 'receipt-key-0001' });
    expect(b.id).toBe(a.id);
    expect(await count('finance.receipts')).toBe(before + 1);
    await expect(
      receipt('76.00', [], fx.customers.intra.id, { key: 'receipt-key-0001' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('concurrent duplicate submissions create exactly one receipt', async () => {
    const before = await count('finance.receipts');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        receipt('33.00', [], fx.customers.intra.id, { key: 'receipt-key-concurrent' }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await count('finance.receipts')).toBe(before + 1);
  });

  it('two receipts racing to pay the same invoice cannot over-pay it', async () => {
    const inv = await issued('1000'); // 1180
    const outcomes = await Promise.allSettled([
      receipt('1180.00', [{ invoiceId: inv.id, amount: '1180.00' }]),
      receipt('1180.00', [{ invoiceId: inv.id, amount: '1180.00' }]),
      receipt('1180.00', [{ invoiceId: inv.id, amount: '1180.00' }]),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of outcomes)
      if (o.status === 'rejected')
        expect(o.reason).toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    expect(await invoice(inv.id)).toMatchObject({
      paidAmount: '1180.00',
      outstandingAmount: '0.00',
    });
  });

  it('different receipts allocating to the same invoice at once cannot over-pay it', async () => {
    // Recording receipts is serialised by the number series; allocating EXISTING receipts is
    // not — only the invoice row lock protects this path.
    const inv = await issued('1000'); // 1180
    const receipts = [await receipt('1180.00'), await receipt('1180.00'), await receipt('1180.00')];
    const outcomes = await Promise.allSettled(
      receipts.map((r) =>
        cmd().execute(
          allocateReceipt,
          { receiptId: r.id, allocations: [{ invoiceId: inv.id, amount: '1180.00' }] },
          fx.actors.accountant,
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of outcomes)
      if (o.status === 'rejected')
        expect(o.reason).toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    expect(await invoice(inv.id)).toMatchObject({
      paidAmount: '1180.00',
      outstandingAmount: '0.00',
    });
  });

  it('forced interleaving: a second allocation waits for the invoice lock, then sees the first', async () => {
    // T1 allocates and holds its transaction open; T2 targets the same invoice. With the row
    // lock, T2 blocks until T1 commits and is then rejected by the application rule. (Without
    // the lock, T2 would read stale data and only the deferred SQL check would catch it.)
    const inv = await issued('1000'); // 1180
    const [r1, r2] = [await receipt('1180.00'), await receipt('1180.00')];
    const db = env.services.db;
    const args = (r: ReceiptDto) => ({
      companyId: fx.companyId,
      receipt: { id: r.id, customerId: r.customerId, amount: r.amount, alreadyAllocated: '0' },
      requests: [{ invoiceId: inv.id, amount: '1180.00' }],
      userId: fx.actors.accountant.user.id,
      now: new Date(),
    });

    const t1 = await db.startTransaction().execute();
    await applyAllocations(t1, args(r1));
    const t2 = await db.startTransaction().execute();
    const second = applyAllocations(t2, args(r2)).then(
      () => 'allocated',
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 150)); // let T2 reach the lock
    await t1.commit().execute();
    const outcome = await second;
    await t2.rollback().execute();

    expect(outcome).toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    expect(await invoice(inv.id)).toMatchObject({ paidAmount: '1180.00', paymentStatus: 'PAID' });
  });

  it('concurrent allocations of one receipt cannot exceed its amount', async () => {
    const [a, b] = [await issued('1000'), await issued('1000')];
    const r = await receipt('1000.00');
    const outcomes = await Promise.allSettled([
      cmd().execute(
        allocateReceipt,
        { receiptId: r.id, allocations: [{ invoiceId: a.id, amount: '600.00' }] },
        fx.actors.accountant,
      ),
      cmd().execute(
        allocateReceipt,
        { receiptId: r.id, allocations: [{ invoiceId: b.id, amount: '600.00' }] },
        fx.actors.accountant,
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      rule: 'EXCEEDS_RECEIPT_AVAILABLE',
    });
    const allocated = await env.services.db
      .selectFrom('finance.receiptAllocations')
      .select((eb) => eb.fn.sum<string>('amount').as('s'))
      .where('receiptId', '=', r.id)
      .executeTakeFirstOrThrow();
    expect(allocated.s).toBe('600.00');
  });
});

describe('database defence in depth', () => {
  it('rejects an over-allocation inserted directly with SQL (deferred check at commit)', async () => {
    const inv = await issued('100'); // 118
    const r = await receipt('1000.00');
    await expect(
      env.services.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('finance.receiptAllocations')
          .values({
            id: uuidv7(),
            companyId: fx.companyId,
            receiptId: r.id,
            invoiceId: inv.id,
            amount: '500.00',
            allocatedBy: fx.actors.owner.user.id,
          })
          .execute();
      }),
    ).rejects.toMatchObject({ code: 'FO003' });
  });

  it('keeps receipts and allocations append-only (runtime: no privilege; owner: trigger)', async () => {
    // The runtime role is refused before any trigger runs; the trigger still binds the owner.
    for (const [db, code] of [
      [env.services.db, '42501'],
      [env.ownerDb, 'FO001'],
    ] as const) {
      await expect(
        db.updateTable('finance.receipts').set({ amount: '1.00' }).execute(),
      ).rejects.toMatchObject({ code });
      await expect(db.deleteFrom('finance.receiptAllocations').execute()).rejects.toMatchObject({
        code,
      });
      await expect(sql`truncate finance.receipts cascade`.execute(db)).rejects.toMatchObject({
        code,
      });
    }
  });
});

describe('receivables summary and ageing', () => {
  it('buckets outstanding by invoice age and reconciles to the customer balance', async () => {
    // Inter-state customer: four invoices of 1180 aged 107, 77, 46 and 5 days.
    // Receipt 1500: 1180 to the oldest, 200 to the 77-day invoice, 120 left on account.
    const open = (
      await env.services.queries.execute(
        listInvoices,
        { customerId: fx.customers.inter.id, status: 'ISSUED' },
        fx.actors.accountant,
      )
    ).sort((x, y) => x.invoiceDate.localeCompare(y.invoiceDate));
    await receipt(
      '1500.00',
      [
        { invoiceId: open[0]!.id, amount: '1180.00' },
        { invoiceId: open[1]!.id, amount: '200.00' },
      ],
      fx.customers.inter.id,
    );

    const summary: ReceivablesSummaryDto = await env.services.queries.execute(
      getReceivablesSummary,
      {},
      fx.actors.accountant,
    );
    expect(summary.asOf).toBe(TODAY);
    const inter = summary.customers.find((c) => c.customerId === fx.customers.inter.id);
    expect(inter).toMatchObject({
      invoicedAmount: '4720.00',
      receivedAmount: '1500.00',
      balance: '3220.00',
      outstandingAmount: '3340.00',
      unallocatedAmount: '120.00',
      openInvoiceCount: 3,
      ageing: { d0_30: '1180.00', d31_60: '1180.00', d61_90: '980.00', d90_plus: '0.00' },
    });

    // Invariant for every customer and the totals: balance = outstanding − unallocated.
    for (const c of [...summary.customers, { ...summary.totals, name: 'TOTAL' }]) {
      expect(
        Money.of(c.outstandingAmount).minus(Money.of(c.unallocatedAmount)).toString(),
        c.name,
      ).toBe(c.balance);
      const bucketSum = Money.sum(Object.values(c.ageing).map((v) => Money.of(v)));
      expect(bucketSum.toString(), c.name).toBe(c.outstandingAmount);
    }
  });

  it('filters invoices by derived payment status', async () => {
    const list = (paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID') =>
      env.services.queries.execute(
        listInvoices,
        { paymentStatus, limit: 200 },
        fx.actors.accountant,
      );
    const [paid, partial, unpaid] = await Promise.all([
      list('PAID'),
      list('PARTIALLY_PAID'),
      list('UNPAID'),
    ]);
    expect(paid.every((i) => i.paymentStatus === 'PAID' && i.outstandingAmount === '0.00')).toBe(
      true,
    );
    expect(partial.every((i) => i.paymentStatus === 'PARTIALLY_PAID')).toBe(true);
    expect(unpaid.every((i) => i.paymentStatus === 'UNPAID' && i.paidAmount === '0.00')).toBe(true);
    expect(paid.length && partial.length && unpaid.length).toBeTruthy();
  });

  it('records an audit trail on the receipt and on every invoice it pays', async () => {
    const inv = await issued('200');
    const r: ReceiptDto = await receipt('236.00', [{ invoiceId: inv.id, amount: '236.00' }]);
    const events = await env.services.db
      .selectFrom('audit.events')
      .select(['entityType', 'entityId', 'command'])
      .where('command', '=', 'finance.receipt.record')
      .where('entityId', 'in', [r.id, inv.id])
      .execute();
    expect(events.map((e) => e.entityType).sort()).toEqual(['finance.receipt', 'sales.invoice']);
  });
});

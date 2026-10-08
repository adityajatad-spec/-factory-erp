import type { CreditNoteDto, InvoiceDto } from '@factory-erp/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { salesFlows } from '../../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { AuthenticatedActor } from '../../platform/actor';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import type { PdfRenderer } from '../../platform/pdf';
import { listAuditEvents } from '../audit/queries';
import { getDocumentContentQuery } from '../documents/queries';
import { createItem } from '../catalog/commands';
import { loadAccess } from '../identity/sessions';
import { createParty } from '../parties/commands';
import { applyAllocations } from '../receivables/allocate';
import { allocateReceipt } from '../receivables/commands';
import {
  deleteCreditNoteDraft,
  issueCreditNote,
  updateCreditNoteDraft,
} from './credit-notes/commands';
import { listCreditNotes } from './credit-notes/queries';
import { createInvoiceDraft } from './draft-commands';
import { issueInvoice } from './issue-command';

const TODAY = '2026-10-05';
const NOW = '2026-10-05T09:30:00Z';

/** Deterministic stand-in for headless Chrome: records the HTML, returns a tiny "PDF". */
const rendered: string[] = [];
const fakeRenderer: PdfRenderer = {
  render: (html) => {
    rendered.push(html);
    return Promise.resolve(Buffer.from(`%PDF-1.4 test ${html.length}`));
  },
  close: () => Promise.resolve(),
};

let env: TestEnv;
let fx: Fixture;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);
const cmd = () => env.services.commands;
const db = () => env.services.db;

beforeAll(async () => {
  env = await createTestEnv({ clock: NOW, pdfRenderer: fakeRenderer });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const seq = (n: string | null) => Number((n ?? '').split('/')[2]);
const TEN_K = '8474.58'; // 1 × ₹8,474.58 @ 18 % → ₹10,000.00
const TWO_K = { invoiceLineNo: 1, quantity: '1', unitRate: '1694.92' }; // → ₹2,000.00

describe('credit note drafts', () => {
  it('prices a draft with the GST engine from the invoice lines (rates and discounts inherited)', async () => {
    const inv = await f.issued('100', { quantity: '10', withCarton: true }); // widget 18 %, carton 5 %
    const ledgerRows = await f.count('finance.partyLedgerEntries');
    const draft = await f.draftCredit(inv, [
      { invoiceLineNo: 2, quantity: '4', unitRate: '50' },
      { invoiceLineNo: 1, quantity: '2', unitRate: '100' },
    ]);
    expect(draft).toMatchObject({
      status: 'DRAFT',
      creditNoteNumber: null,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customerId,
      supplyType: 'INTRA_STATE',
      reasonCode: 'SALES_RETURN',
      totals: {
        taxableAmount: '400.00', // 4 × 50 + 2 × 100
        cgstAmount: '23.00', // 200 × 2.5 % + 200 × 9 %
        sgstAmount: '23.00',
        igstAmount: '0.00',
        grandTotal: '446.00',
      },
    });
    expect(draft.lines.map((l) => [l.lineNo, l.invoiceLineNo, l.gstRatePercent])).toEqual([
      [1, 2, '5'],
      [2, 1, '18'],
    ]);
    // A draft changes no balance.
    expect(await f.count('finance.partyLedgerEntries')).toBe(ledgerRows);
    expect((await f.invoice(inv.id)).outstandingAmount).toBe(inv.grandTotal);
  });

  it('updates a draft with optimistic concurrency, and deletes drafts only', async () => {
    const inv = await f.issued(TEN_K);
    const draft = await f.draftCredit(inv, [TWO_K]);
    const updated = await cmd().execute(
      updateCreditNoteDraft,
      {
        creditNoteId: draft.id,
        expectedVersion: draft.version,
        creditNoteDate: TODAY,
        reasonCode: 'POST_SALE_DISCOUNT',
        reason: 'Agreed volume discount',
        lines: [{ invoiceLineNo: 1, quantity: '1', unitRate: '847.46' }],
      },
      fx.actors.accountant,
    );
    expect(updated).toMatchObject({
      version: 2,
      reasonCode: 'POST_SALE_DISCOUNT',
      grandTotal: '1000.00',
    });
    await expect(
      cmd().execute(
        deleteCreditNoteDraft,
        { creditNoteId: draft.id, expectedVersion: draft.version },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await cmd().execute(
      deleteCreditNoteDraft,
      { creditNoteId: draft.id, expectedVersion: updated.version },
      fx.actors.accountant,
    );
    await expect(f.creditNote(draft.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('G: rejects crediting a different customer’s invoice', async () => {
    const inv = await f.issued('100');
    await expect(
      f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }], {
        customerId: fx.customers.inter.id,
      }),
    ).rejects.toMatchObject({ rule: 'CUSTOMER_MISMATCH' });
  });

  it('rejects drafts against draft or cancelled invoices', async () => {
    const draftInvoice = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }],
      },
      fx.actors.accountant,
    );
    await expect(
      f.draftCredit(draftInvoice, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }]),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
    const cancelled = await f.cancel(await f.issued('100'));
    await expect(
      f.draftCredit(cancelled, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }]),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
  });

  it('checks every line against the invoice line it credits — and reports all problems', async () => {
    const inv = await f.issued('100', { quantity: '5' });
    const err = (await f
      .draftCredit(inv, [
        { invoiceLineNo: 1, quantity: '6', unitRate: '100.01' },
        { invoiceLineNo: 9, quantity: '1', unitRate: '1' },
      ])
      .catch((e: unknown) => e)) as BusinessRuleError;
    expect(err).toBeInstanceOf(BusinessRuleError);
    expect(err.rule).toBe('EXCEEDS_LINE_QUANTITY');
    expect(err.issues?.map((i) => i.path)).toEqual([
      'lines.0.quantity',
      'lines.0.unitRate',
      'lines.1.invoiceLineNo',
    ]);
    await expect(
      f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '0' }]),
    ).rejects.toMatchObject({ rule: 'CREDIT_NOTE_ZERO' });
    await expect(
      f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }], {
        date: '2026-10-04',
      }),
    ).rejects.toMatchObject({ rule: 'CREDIT_NOTE_BEFORE_INVOICE' });
  });
});

describe('issuing credit notes: ledger and receivables scenarios', () => {
  it('A: ₹10,000 invoice → ₹2,000 credit note → ₹8,000 outstanding', async () => {
    const inv = await f.issued(TEN_K);
    expect(inv.grandTotal).toBe('10000.00');
    const balanceBefore = await f.ledgerBalance(inv.customerId);
    const cn = await f.credit(inv, [TWO_K]);

    expect(cn).toMatchObject({ status: 'ISSUED', grandTotal: '2000.00', invoiceId: inv.id });
    expect(cn.creditNoteNumber).toMatch(/^CN\/26-27\/\d{5}$/);
    expect(cn.calcEngineVersion).toBe(inv.calcEngineVersion);
    expect(await f.invoice(inv.id)).toMatchObject({
      paymentStatus: 'UNPAID',
      paidAmount: '0.00',
      creditedAmount: '2000.00',
      outstandingAmount: '8000.00',
      creditNotes: [{ creditNoteId: cn.id, status: 'ISSUED', grandTotal: '2000.00' }],
    });
    // Customer ledger: one new CREDIT_NOTE credit, nothing edited.
    const ledger = await f.ledgerOf(cn.id);
    expect(ledger.map((l) => [l.entryType, l.debit, l.credit])).toEqual([
      ['CREDIT_NOTE', '0.00', '2000.00'],
    ]);
    expect(await f.ledgerBalance(inv.customerId)).toBe(
      f.money(String(Number(balanceBefore) - 2000)),
    );
  });

  it('B: ₹10,000 invoice → ₹6,000 receipt → ₹2,000 credit note → ₹2,000 outstanding', async () => {
    const inv = await f.issued(TEN_K);
    await f.receipt('6000.00', [{ invoiceId: inv.id, amount: '6000.00' }]);
    await f.credit(inv, [TWO_K]);
    expect(await f.invoice(inv.id)).toMatchObject({
      paymentStatus: 'PARTIALLY_PAID',
      paidAmount: '6000.00',
      creditedAmount: '2000.00',
      outstandingAmount: '2000.00',
    });
  });

  it('C: a full credit note leaves exactly ₹0 outstanding and marks the invoice CREDITED', async () => {
    const inv = await f.issued(TEN_K, { withCarton: true }); // 10,000 + carton 525 → 10,525
    const cn = await f.credit(inv, [
      { invoiceLineNo: 1, quantity: '1', unitRate: TEN_K },
      { invoiceLineNo: 2, quantity: '10', unitRate: '50' },
    ]);
    expect(cn.totals).toEqual(inv.totals); // same engine, same inputs → identical figures
    expect(await f.invoice(inv.id)).toMatchObject({
      paymentStatus: 'CREDITED',
      outstandingAmount: '0.00',
      creditedAmount: inv.grandTotal,
    });
    // Nothing is left to credit or to pay.
    await expect(
      f.draftCredit(inv, [{ invoiceLineNo: 2, quantity: '1', unitRate: '1' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_LINE_CREDITABLE' });
    await expect(f.receipt('1.00', [{ invoiceId: inv.id, amount: '1.00' }])).rejects.toMatchObject({
      rule: 'EXCEEDS_INVOICE_OUTSTANDING',
    });
  });

  it('F: crediting more than the outstanding is rejected at draft time', async () => {
    const inv = await f.issued(TEN_K);
    await f.receipt('9000.00', [{ invoiceId: inv.id, amount: '9000.00' }]);
    await expect(f.draftCredit(inv, [TWO_K])).rejects.toMatchObject({
      rule: 'EXCEEDS_INVOICE_OUTSTANDING',
    });
  });

  it('F: …and at issue time, atomically: no number used, no ledger entry, draft untouched', async () => {
    const inv = await f.issued(TEN_K);
    const draft = await f.draftCredit(inv, [TWO_K]); // valid when drafted
    await f.receipt('9000.00', [{ invoiceId: inv.id, amount: '9000.00' }]); // then a payment lands
    const before = await f.credit(await f.issued('100'), [
      { invoiceLineNo: 1, quantity: '1', unitRate: '10' },
    ]);
    const ledgerRows = await f.count('finance.partyLedgerEntries');

    await expect(f.issueCredit(draft)).rejects.toMatchObject({
      rule: 'EXCEEDS_INVOICE_OUTSTANDING',
    });
    expect(await f.creditNote(draft.id)).toMatchObject({
      status: 'DRAFT',
      creditNoteNumber: null,
      version: draft.version,
    });
    expect(await f.count('finance.partyLedgerEntries')).toBe(ledgerRows);
    expect((await f.invoice(inv.id)).outstandingAmount).toBe('1000.00');
    // Gapless: the next credit note takes the very next number.
    const next = await f.credit(await f.issued('100'), [
      { invoiceLineNo: 1, quantity: '1', unitRate: '10' },
    ]);
    expect(seq(next.creditNoteNumber)).toBe(seq(before.creditNoteNumber) + 1);
  });

  it('H: credit notes can never push an invoice into negative outstanding', async () => {
    const inv = await f.issued(TEN_K);
    await f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '5084.75' }]); // ₹6,000
    await expect(
      f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '5084.75' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_LINE_CREDITABLE' });
    // 1 paisa more than the line's remaining taxable value (₹3,389.83) is refused…
    await expect(
      f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '3389.84' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_LINE_CREDITABLE' });
    // …exactly the remainder is accepted: ₹3,999.99 rounds to ₹4,000.00 = the outstanding.
    await expect(
      f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '3389.83' }]),
    ).resolves.toMatchObject({ grandTotal: '4000.00' });
    expect(await f.invoice(inv.id)).toMatchObject({ outstandingAmount: '0.00' });
  });

  it('I: receipts, allocations and credit notes together still reconcile everywhere', async () => {
    const inv = await f.issued(TEN_K);
    const r = await f.receipt('7000.00'); // on account for now
    await f.credit(inv, [TWO_K]); // outstanding 8,000
    await expect(
      cmd().execute(
        allocateReceipt,
        { receiptId: r.id, allocations: [{ invoiceId: inv.id, amount: '8000.01' }] },
        fx.actors.accountant,
      ),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    await cmd().execute(
      allocateReceipt,
      { receiptId: r.id, allocations: [{ invoiceId: inv.id, amount: '7000.00' }] },
      fx.actors.accountant,
    );
    await expect(
      f.receipt('1001.00', [{ invoiceId: inv.id, amount: '1000.01' }]),
    ).rejects.toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    await f.receipt('1000.00', [{ invoiceId: inv.id, amount: '1000.00' }]);
    expect(await f.invoice(inv.id)).toMatchObject({
      paymentStatus: 'PAID',
      paidAmount: '8000.00',
      creditedAmount: '2000.00',
      outstandingAmount: '0.00',
    });

    // The SQL view and the read model agree on every issued invoice.
    const view = await db()
      .selectFrom('finance.invoiceBalances')
      .select(['invoiceId', 'outstandingAmount', 'creditedAmount', 'paidAmount'])
      .where('companyId', '=', fx.companyId)
      .execute();
    for (const v of view.slice(0, 25)) {
      const dto = await f.invoice(v.invoiceId ?? '');
      expect([dto.outstandingAmount, dto.creditedAmount, dto.paidAmount]).toEqual([
        v.outstandingAmount,
        v.creditedAmount,
        v.paidAmount,
      ]);
    }
    // balance = Σ outstanding − Σ unallocated, per customer and in total; ledger agrees.
    const s = await f.summary();
    for (const c of [...s.customers, { ...s.totals, customerId: null }]) {
      expect(f.money(c.balance)).toBe(
        f.money(String(Number(c.outstandingAmount) - Number(c.unallocatedAmount))),
      );
      expect(f.money(c.balance)).toBe(
        f.money(
          String(Number(c.invoicedAmount) - Number(c.creditedAmount) - Number(c.receivedAmount)),
        ),
      );
      if (c.customerId) expect(c.balance).toBe(await f.ledgerBalance(c.customerId));
    }
  });

  it('credits an inter-state invoice in IGST with the original line discount', async () => {
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.inter.id,
        invoiceDate: TODAY,
        lines: [
          { itemId: fx.items.widget.id, quantity: '10', unitRate: '380', discountPercent: '5' },
        ],
      },
      fx.actors.accountant,
    );
    const inv = await cmd().execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      fx.actors.accountant,
    );
    const cn = await f.credit(inv, [{ invoiceLineNo: 1, quantity: '2', unitRate: '380' }]);
    expect(cn).toMatchObject({
      supplyType: 'INTER_STATE',
      totals: {
        grossAmount: '760.00',
        discountAmount: '38.00',
        taxableAmount: '722.00',
        igstAmount: '129.96',
        cgstAmount: '0.00',
        grandTotal: '852.00',
      },
    });
    expect(cn.lines[0]).toMatchObject({ discountPercent: '5', igstRatePercent: '18' });
  });

  it('a draft whose invoice was cancelled meanwhile can no longer be issued', async () => {
    const inv = await f.issued('100');
    const draft = await f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '50' }]);
    await f.cancel(inv);
    await expect(f.issueCredit(draft)).rejects.toMatchObject({ rule: 'INVOICE_NOT_ISSUED' });
  });

  it('rejects issuing a future-dated credit note', async () => {
    const inv = await f.issued('100');
    const draft = await f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '50' }], {
      date: '2026-10-06',
    });
    await expect(f.issueCredit(draft)).rejects.toMatchObject({
      rule: 'CREDIT_NOTE_DATE_IN_FUTURE',
    });
  });
});

describe('cross-company isolation', () => {
  async function otherCompanyInvoice(): Promise<{
    invoice: InvoiceDto;
    actor: AuthenticatedActor;
  }> {
    const companyId = uuidv7();
    await db()
      .insertInto('platform.companies')
      .values({
        id: companyId,
        legalName: 'Other Works Pvt Ltd',
        gstin: '27OTHRO0001A1Z1',
        stateCode: '27',
        addressLine1: 'Other Road',
        city: 'Pune',
        postalCode: '411000',
        isDemo: true,
      })
      .execute();
    const userId = uuidv7();
    await db()
      .insertInto('identity.users')
      .values({ id: userId, username: 'otherowner', displayName: 'Other', passwordHash: 'x' })
      .execute();
    await db()
      .insertInto('identity.userRoles')
      .values({ userId, roleCode: 'OWNER', companyId })
      .execute();
    const access = await loadAccess(db(), userId, companyId);
    const actor: AuthenticatedActor = {
      requestId: 'test-other',
      actorKind: 'user',
      user: {
        id: userId,
        username: 'otherowner',
        displayName: 'Other',
        companyId,
        sessionId: uuidv7(),
        roles: access.roles,
        permissions: access.permissions,
        mustChangePassword: false,
      },
    };
    const customer = await cmd().execute(
      createParty,
      { code: 'OC', name: 'Other Customer', isCustomer: true, isSupplier: false, stateCode: '27' },
      actor,
    );
    const item = await cmd().execute(
      createItem,
      { code: 'OW', name: 'Other Widget', itemType: 'FINISHED_GOOD', uom: 'NOS', hsnCode: '7326' },
      actor,
    );
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: customer.id,
        invoiceDate: TODAY,
        lines: [{ itemId: item.id, quantity: '1', unitRate: '100' }],
      },
      actor,
    );
    const invoice = await cmd().execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      actor,
    );
    return { invoice, actor };
  }

  it('cannot see or credit another company’s invoice — via commands or raw SQL', async () => {
    const { invoice } = await otherCompanyInvoice();
    await expect(
      f.draftCredit(invoice, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }]),
    ).rejects.toBeInstanceOf(NotFoundError);

    // A hand-written row claiming our company for their invoice violates the composite FK.
    const own = await f.draftCredit(await f.issued('100'), [
      { invoiceLineNo: 1, quantity: '1', unitRate: '10' },
    ]);
    await expect(
      sql`update sales.credit_notes set invoice_id = ${invoice.id}, customer_id = ${invoice.customerId} where id = ${own.id}`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`insert into sales.credit_notes (id, company_id, credit_note_date, invoice_id, customer_id, reason_code, reason,
            supplier_state_code, place_of_supply_state_code, supply_type, gross_amount, discount_amount, taxable_amount,
            cgst_amount, sgst_amount, igst_amount, total_tax, round_off, grand_total, amount_in_words, calc_engine_version, gst_policy)
          values (${uuidv7()}, ${fx.companyId}, ${TODAY}, ${invoice.id}, ${invoice.customerId}, 'OTHER', 'sql test',
            '27', '27', 'INTRA_STATE', 1, 0, 1, 0, 0, 0, 0, 0, 1, 'x', '1.0.0', '{}')`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('numbering', () => {
  it('numbers concurrent issues gaplessly and uniquely', async () => {
    const drafts: CreditNoteDto[] = [];
    for (let i = 0; i < 6; i++) {
      const inv = await f.issued('100');
      drafts.push(await f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '10' }]));
    }
    const issued = await Promise.all(drafts.map((d) => f.issueCredit(d)));
    const numbers = issued.map((c) => seq(c.creditNoteNumber)).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(6);
    expect((numbers.at(-1) ?? 0) - (numbers[0] ?? 0)).toBe(5);
  });

  it('starts a new series in a new financial year and keeps each series in date order', async () => {
    const fyEnv = await createTestEnv({ clock: '2027-04-01T06:00:00Z' }); // 1 Apr 2027, IST
    try {
      const fyFx = await createFixture(fyEnv.services);
      const g = salesFlows(
        () => fyEnv,
        () => fyFx,
        '2027-04-01',
      );
      const inv = await g.issued(TEN_K, { date: '2027-03-30' });
      const march = await g.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }], {
        date: '2027-03-31',
      });
      const april = await g.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }], {
        date: '2027-04-01',
      });
      expect(march.creditNoteNumber).toBe('CN/26-27/00001');
      expect(april.creditNoteNumber).toBe('CN/27-28/00001');
      await expect(
        g.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '100' }], {
          date: '2027-03-30',
        }),
      ).rejects.toMatchObject({ rule: 'DATE_BEFORE_LAST_ISSUED' });
    } finally {
      await fyEnv.destroy();
    }
  });
});

describe('concurrency', () => {
  it('two credit notes racing on one invoice cannot over-credit it', async () => {
    const inv = await f.issued(TEN_K);
    const line = { invoiceLineNo: 1, quantity: '1', unitRate: '5084.75' }; // ₹6,000 each
    const [a, b] = [await f.draftCredit(inv, [line]), await f.draftCredit(inv, [line])];
    const outcomes = await Promise.allSettled([f.issueCredit(a), f.issueCredit(b)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      rule: 'EXCEEDS_LINE_CREDITABLE',
    });
    expect((await f.invoice(inv.id)).outstandingAmount).toBe('4000.00');
  });

  it('forced interleaving: issuing waits for a payment holding the invoice lock, then sees it', async () => {
    // T1 allocates a payment for the whole invoice and keeps its transaction open. T2 issues a
    // credit note on the same invoice. With the settlement lock, T2 blocks until T1 commits
    // and is then rejected by the application rule. (Without the lock T2 would read stale
    // amounts and issue; only the deferred SQL check would catch it at commit.)
    const inv = await f.issued(TEN_K);
    const draft = await f.draftCredit(inv, [TWO_K]);
    const r = await f.receipt('10000.00');

    const t1 = await db().startTransaction().execute();
    await applyAllocations(t1, {
      companyId: fx.companyId,
      receipt: { id: r.id, customerId: r.customerId, amount: r.amount, alreadyAllocated: '0' },
      requests: [{ invoiceId: inv.id, amount: '10000.00' }],
      userId: fx.actors.accountant.user.id,
      now: new Date(NOW),
    });
    const t2 = await db().startTransaction().execute();
    const second = issueCreditNote
      .handler(
        { tx: t2, actor: fx.actors.accountant, companyId: fx.companyId, now: new Date(NOW) },
        { creditNoteId: draft.id, expectedVersion: draft.version },
      )
      .then(
        () => 'issued',
        (e: unknown) => e,
      );
    await new Promise((resolve) => setTimeout(resolve, 150)); // let T2 reach the lock
    await t1.commit().execute();
    const outcome = await second;
    await t2.rollback().execute();

    expect(outcome).toMatchObject({ rule: 'EXCEEDS_INVOICE_OUTSTANDING' });
    expect(await f.invoice(inv.id)).toMatchObject({
      paymentStatus: 'PAID',
      creditedAmount: '0.00',
    });
  });
});

describe('database defence in depth', () => {
  it('rejects at COMMIT an over-crediting credit note marked issued with raw SQL (FO004)', async () => {
    const inv = await f.issued('1000'); // 1180
    const draft = await f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '500' }]);
    await f.receipt('1180.00', [{ invoiceId: inv.id, amount: '1180.00' }]); // nothing left to credit
    await expect(
      sql`update sales.credit_notes
             set status = 'ISSUED', credit_note_number = 'CN/26-27/99999', fiscal_year = '2026-27',
                 issued_at = now(), issued_by = ${fx.actors.owner.user.id},
                 seller_snapshot = '{}', customer_snapshot = '{}'
           where id = ${draft.id}`.execute(db()),
    ).rejects.toMatchObject({ code: 'FO004' });
    expect((await f.creditNote(draft.id)).status).toBe('DRAFT');
  });

  it('rejects at COMMIT a payment allocated over a credited invoice with raw SQL (FO003)', async () => {
    const inv = await f.issued('1000');
    await f.credit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '1000' }]); // fully credited
    const r = await f.receipt('10.00');
    await expect(
      sql`insert into finance.receipt_allocations (id, company_id, receipt_id, invoice_id, amount, allocated_by)
          values (${uuidv7()}, ${fx.companyId}, ${r.id}, ${inv.id}, 1, ${fx.actors.owner.user.id})`.execute(
        db(),
      ),
    ).rejects.toMatchObject({ code: 'FO003' });
  });

  it('issued credit notes, their lines and ledger entries are immutable', async () => {
    const cn = await f.credit(await f.issued('100'), [
      { invoiceLineNo: 1, quantity: '1', unitRate: '10' },
    ]);
    const attempt = (q: ReturnType<typeof sql>) => q.execute(db());
    await expect(
      attempt(sql`update sales.credit_notes set grand_total = 1 where id = ${cn.id}`),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      attempt(sql`update sales.credit_notes set reason = 'edited' where id = ${cn.id}`),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      attempt(sql`delete from sales.credit_notes where id = ${cn.id}`),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      attempt(
        sql`update sales.credit_note_lines set quantity = 0.5 where credit_note_id = ${cn.id}`,
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
    const deleteLedger = sql`delete from finance.party_ledger_entries where source_id = ${cn.id}`;
    await expect(attempt(deleteLedger)).rejects.toMatchObject({ code: '42501' });
    await expect(deleteLedger.execute(env.ownerDb)).rejects.toMatchObject({ code: 'FO001' });
  });
});

describe('idempotency, permissions, AI tiers and audit', () => {
  it('replays a repeated Idempotency-Key instead of issuing twice', async () => {
    const draft = await f.draftCredit(await f.issued('100'), [
      { invoiceLineNo: 1, quantity: '1', unitRate: '10' },
    ]);
    const key = `cn-${uuidv7()}`;
    const first = await f.issueCredit(draft, { key });
    const again = await f.issueCredit(draft, { key });
    expect(again).toEqual(first);
    expect(await f.ledgerOf(draft.id)).toHaveLength(1);
  });

  it('only authorised roles draft or issue credit notes', async () => {
    const inv = await f.issued('100');
    const line = [{ invoiceLineNo: 1, quantity: '1', unitRate: '10' }];
    await expect(f.draftCredit(inv, line, { actor: fx.actors.worker })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const draft = await f.draftCredit(inv, line);
    await expect(f.issueCredit(draft, { actor: fx.actors.worker })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      env.services.queries.execute(listCreditNotes, {}, fx.actors.worker),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the AI may prepare and edit drafts but never issue or delete them', async () => {
    const ai = asAiAgent(fx.actors.accountant);
    const inv = await f.issued('100');
    const draft = await f.draftCredit(inv, [{ invoiceLineNo: 1, quantity: '1', unitRate: '10' }], {
      actor: ai,
    });
    const edited = await cmd().execute(
      updateCreditNoteDraft,
      {
        creditNoteId: draft.id,
        expectedVersion: draft.version,
        creditNoteDate: TODAY,
        reasonCode: 'SALES_RETURN',
        reason: 'One unit returned',
        lines: [{ invoiceLineNo: 1, quantity: '1', unitRate: '20' }],
      },
      ai,
    );
    await expect(f.issueCredit(edited, { actor: ai })).rejects.toThrow(
      /requires a human \(AI tier CONFIRM\)/,
    );
    await expect(
      cmd().execute(
        deleteCreditNoteDraft,
        { creditNoteId: draft.id, expectedVersion: edited.version },
        ai,
      ),
    ).rejects.toThrow(/AI tier CONFIRM/);
    const audit = await db()
      .selectFrom('audit.events')
      .select(['command', 'actorKind', 'aiSessionId'])
      .where('entityId', '=', draft.id)
      .execute();
    expect(audit.every((a) => a.actorKind === 'ai_agent' && a.aiSessionId)).toBe(true);
    expect(audit.map((a) => a.command).sort()).toEqual([
      'sales.creditNote.createDraft',
      'sales.creditNote.updateDraft',
    ]);
  });

  it('audits the credit note and the invoice it reduces', async () => {
    const inv = await f.issued(TEN_K);
    const cn = await f.credit(inv, [TWO_K]);
    const history = (entityType: string, entityId: string) =>
      env.services.queries.execute(listAuditEvents, { entityType, entityId }, fx.actors.accountant);
    const cnHistory = await history('sales.credit_note', cn.id);
    expect(cnHistory.find((h) => h.command === 'sales.creditNote.issue')?.summary).toBe(
      `Issued as ${cn.creditNoteNumber ?? ''} against ${inv.invoiceNumber ?? ''} (total ₹2,000.00)`,
    );
    const invHistory = await history('sales.invoice', inv.id);
    expect(invHistory.find((h) => h.command === 'sales.creditNote.issue')?.summary).toBe(
      `Credit note ${cn.creditNoteNumber ?? ''} for ₹2,000.00 issued (outstanding now ₹8,000.00)`,
    );
  });
});

describe('credit note PDF', () => {
  it('is rendered by the outbox once, stored by hash, watermarked SPECIMEN and audited', async () => {
    const cn = await f.credit(await f.issued(TEN_K), [TWO_K]);
    rendered.length = 0;
    await env.services.outbox.runOnce(100);
    const html = rendered.find((h) => h.includes(cn.creditNoteNumber ?? '?'));
    expect(html).toBeDefined();
    expect(html).toContain('CREDIT NOTE');
    expect(html).toContain('SPECIMEN — NOT A VALID CREDIT NOTE');
    expect(html).toContain('DEMO DATA');

    const withPdf = await f.creditNote(cn.id);
    expect(withPdf.pdfDocumentId).toBeTruthy();
    const doc = await db()
      .selectFrom('docs.documents')
      .selectAll()
      .where('id', '=', withPdf.pdfDocumentId ?? '')
      .executeTakeFirstOrThrow();
    expect(doc).toMatchObject({
      kind: 'SALES_CREDIT_NOTE_PDF',
      mimeType: 'application/pdf',
      filename: `${(cn.creditNoteNumber ?? '').replace(/\//g, '-')}.pdf`,
    });
    const content = await env.services.queries.execute(
      getDocumentContentQuery(env.services.blobStore),
      { documentId: doc.id },
      fx.actors.accountant,
    );
    expect(content.content.subarray(0, 5).toString()).toBe('%PDF-');

    const history = await env.services.queries.execute(
      listAuditEvents,
      { entityType: 'sales.credit_note', entityId: cn.id },
      fx.actors.accountant,
    );
    expect(
      history.find((h) => h.command === 'documents.salesCreditNotePdf.generate'),
    ).toMatchObject({ actorKind: 'system', summary: 'Credit note PDF generated' });
    // Re-running the outbox never regenerates it; SQL refuses to replace it.
    await env.services.outbox.runOnce(100);
    expect((await f.creditNote(cn.id)).pdfDocumentId).toBe(withPdf.pdfDocumentId);
    await expect(
      sql`update sales.credit_notes set pdf_document_id = null where id = ${cn.id}`.execute(db()),
    ).rejects.toMatchObject({ code: 'FO002' });
  });
});

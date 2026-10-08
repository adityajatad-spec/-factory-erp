import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { createInvoiceDraft, deleteInvoiceDraft, updateInvoiceDraft } from './draft-commands';
import { issueInvoice } from './issue-command';

// Clock fixed at 2026-10-05 15:00 IST so date rules are deterministic.
let env: TestEnv;
let fx: Fixture;

beforeAll(async () => {
  env = await createTestEnv({ clock: '2026-10-05T09:30:00Z' });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  customerId: fx.customers.intra.id,
  invoiceDate: '2026-10-01',
  lines: [
    { itemId: fx.items.widget.id, quantity: '10', unitRate: '125.50' },
    { itemId: fx.items.carton.id, quantity: '4', unitRate: '12.25', discountPercent: '10' },
  ],
  ...overrides,
});

const newDraft = (overrides: Record<string, unknown> = {}) =>
  env.services.commands.execute(createInvoiceDraft, draftInput(overrides), fx.actors.accountant);

describe('draft invoices', () => {
  it('computes GST on the server; client-supplied totals are ignored', async () => {
    const draft = await env.services.commands.execute(
      createInvoiceDraft,
      { ...draftInput(), grandTotal: '1.00', totals: { grandTotal: '1.00' } },
      fx.actors.accountant,
    );
    // 10 × 125.50 = 1255.00 @18% → CGST 112.95 + SGST 112.95
    // 4 × 12.25 = 49.00 − 10% = 44.10 @5% → CGST 1.10 + SGST 1.10 (1.1025 → 1.10)
    expect(draft.status).toBe('DRAFT');
    expect(draft.invoiceNumber).toBeNull();
    expect(draft.supplyType).toBe('INTRA_STATE');
    expect(draft.totals).toEqual({
      grossAmount: '1304.00',
      discountAmount: '4.90',
      taxableAmount: '1299.10',
      cgstAmount: '114.05',
      sgstAmount: '114.05',
      igstAmount: '0.00',
      totalTax: '228.10',
      roundOff: '-0.20',
      grandTotal: '1527.00',
    });
    expect(draft.amountInWords).toBe('Rupees One Thousand Five Hundred Twenty Seven Only');
    expect(draft.lines.map((l) => l.gstRatePercent)).toEqual(['18', '5']);
  });

  it('uses IGST for an inter-state customer', async () => {
    const draft = await newDraft({ customerId: fx.customers.inter.id });
    expect(draft.supplyType).toBe('INTER_STATE');
    expect(draft.totals.cgstAmount).toBe('0.00');
    expect(draft.totals.igstAmount).toBe('228.11'); // 225.90 + 2.205 → 2.21
  });

  it('rejects raw materials on a sales invoice and unknown items', async () => {
    await expect(
      newDraft({ lines: [{ itemId: fx.items.rawMaterial.id, quantity: '1', unitRate: '1' }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      newDraft({ lines: [{ itemId: uuidv7(), quantity: '1', unitRate: '1' }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces optimistic concurrency on updates', async () => {
    const draft = await newDraft();
    const updated = await env.services.commands.execute(
      updateInvoiceDraft,
      {
        ...draftInput({ lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }] }),
        invoiceId: draft.id,
        expectedVersion: draft.version,
      },
      fx.actors.accountant,
    );
    expect(updated.version).toBe(draft.version + 1);
    expect(updated.totals.grandTotal).toBe('118.00');
    await expect(
      env.services.commands.execute(
        updateInvoiceDraft,
        { ...draftInput(), invoiceId: draft.id, expectedVersion: draft.version },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('deletes drafts', async () => {
    const draft = await newDraft();
    await env.services.commands.execute(
      deleteInvoiceDraft,
      { invoiceId: draft.id, expectedVersion: draft.version },
      fx.actors.accountant,
    );
    const row = await env.services.db
      .selectFrom('sales.invoices')
      .select('id')
      .where('id', '=', draft.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});

describe('issuing', () => {
  it('assigns a number, snapshots, posts the receivable, audits and emits an outbox event — atomically', async () => {
    const draft = await newDraft({ invoiceDate: '2026-10-02' });
    const issued = await env.services.commands.execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      fx.actors.accountant,
    );

    expect(issued.status).toBe('ISSUED');
    expect(issued.invoiceNumber).toMatch(/^INV\/26-27\/\d{5}$/);
    expect(issued.version).toBe(draft.version + 1);

    const db = env.services.db;
    const row = await db
      .selectFrom('sales.invoices')
      .selectAll()
      .where('id', '=', draft.id)
      .executeTakeFirstOrThrow();
    expect(row.fiscalYear).toBe('2026-27');
    expect(row.customerSnapshot).toMatchObject({
      name: 'Intra Customer',
      gstin: '27TESTO0002B1Z2',
    });
    expect(row.sellerSnapshot).toMatchObject({ legalName: 'Test Works Pvt Ltd' });

    const ledger = await db
      .selectFrom('finance.partyLedgerEntries')
      .selectAll()
      .where('sourceId', '=', draft.id)
      .execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entryType: 'SALES_INVOICE',
      debit: issued.grandTotal,
      partyId: fx.customers.intra.id,
    });

    const outbox = await db
      .selectFrom('system.outboxEvents')
      .selectAll()
      .where('aggregateId', '=', draft.id)
      .execute();
    expect(outbox.map((o) => o.topic)).toEqual(['sales.invoice.issued']);

    const audit = await db
      .selectFrom('audit.events')
      .selectAll()
      .where('entityId', '=', draft.id)
      .where('command', '=', 'sales.invoice.issue')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({
      status: 'ISSUED',
      invoiceNumber: issued.invoiceNumber,
    });
  });

  it('refuses to issue twice, or with a stale version', async () => {
    const draft = await newDraft({ invoiceDate: '2026-10-03' });
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: draft.id, expectedVersion: draft.version + 7 },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await env.services.commands.execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      fx.actors.accountant,
    );
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: draft.id, expectedVersion: draft.version + 1 },
        fx.actors.accountant,
      ),
    ).rejects.toMatchObject({ rule: 'INVOICE_NOT_DRAFT' });
  });

  it('rejects future-dated invoices and dates before the last issued invoice', async () => {
    const future = await newDraft({ invoiceDate: '2026-10-06' });
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: future.id, expectedVersion: future.version },
        fx.actors.accountant,
      ),
    ).rejects.toMatchObject({ rule: 'INVOICE_DATE_IN_FUTURE' });

    const backdated = await newDraft({ invoiceDate: '2026-09-01' });
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: backdated.id, expectedVersion: backdated.version },
        fx.actors.accountant,
      ),
    ).rejects.toMatchObject({ rule: 'DATE_BEFORE_LAST_ISSUED' });
  });

  it('allocates gapless, unique numbers under concurrency', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 8 }, () => newDraft({ invoiceDate: '2026-10-05' })),
    );
    const issued = await Promise.all(
      drafts.map((d) =>
        env.services.commands.execute(
          issueInvoice,
          { invoiceId: d.id, expectedVersion: d.version },
          fx.actors.accountant,
        ),
      ),
    );
    const all = await env.services.db
      .selectFrom('sales.invoices')
      .select('invoiceNumber')
      .where('status', '=', 'ISSUED')
      .orderBy('invoiceNumber')
      .execute();
    const seq = all.map((r) => Number(r.invoiceNumber?.split('/')[2]));
    expect(seq).toEqual(Array.from({ length: seq.length }, (_, i) => i + 1));
    expect(new Set(issued.map((i) => i.invoiceNumber)).size).toBe(8);
  });

  it('recalculates at issue with the rate in force on the invoice date', async () => {
    const db = env.services.db;
    // Rate for HSN 4819 changes from 2026-10-04: 5% → 12% (synthetic test data).
    await db
      .updateTable('catalog.gstRates')
      .set({ effectiveTo: '2026-10-03' })
      .where('hsnCode', '=', '4819')
      .execute();
    await db
      .insertInto('catalog.gstRates')
      .values({
        id: uuidv7(),
        hsnCode: '4819',
        ratePercent: '12',
        effectiveFrom: '2026-10-04',
        sourceNote: 'test',
        verificationStatus: 'DEMO_UNVERIFIED',
      })
      .execute();
    const draft = await newDraft({
      invoiceDate: '2026-10-05',
      lines: [{ itemId: fx.items.carton.id, quantity: '100', unitRate: '10' }],
    });
    expect(draft.lines[0]?.gstRatePercent).toBe('12');
    expect(draft.totals.grandTotal).toBe('1120.00');
  });

  it('cannot issue a non-existent invoice', async () => {
    await expect(
      env.services.commands.execute(
        issueInvoice,
        { invoiceId: uuidv7(), expectedVersion: 1 },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('immutability (enforced by PostgreSQL, not just the application)', () => {
  it('blocks changes to an issued invoice, its lines and deletion', async () => {
    const draft = await newDraft({ invoiceDate: '2026-10-05' });
    await env.services.commands.execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      fx.actors.accountant,
    );
    const db = env.services.db;
    await expect(
      db
        .updateTable('sales.invoices')
        .set({ grandTotal: '1.00' })
        .where('id', '=', draft.id)
        .execute(),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      db
        .updateTable('sales.invoiceLines')
        .set({ quantity: '999' })
        .where('invoiceId', '=', draft.id)
        .execute(),
    ).rejects.toMatchObject({
      code: 'FO002',
    });
    await expect(
      db.deleteFrom('sales.invoices').where('id', '=', draft.id).execute(),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      env.services.commands.execute(
        deleteInvoiceDraft,
        { invoiceId: draft.id, expectedVersion: draft.version + 1 },
        fx.actors.accountant,
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('keeps audit events and the party ledger append-only (runtime: no privilege; owner: trigger)', async () => {
    for (const [db, code] of [
      [env.services.db, '42501'],
      [env.ownerDb, 'FO001'],
    ] as const) {
      await expect(
        db.updateTable('audit.events').set({ command: 'tampered' }).execute(),
      ).rejects.toMatchObject({ code });
      await expect(db.deleteFrom('audit.events').execute()).rejects.toMatchObject({ code });
      await expect(db.deleteFrom('finance.partyLedgerEntries').execute()).rejects.toMatchObject({
        code,
      });
    }
  });
});

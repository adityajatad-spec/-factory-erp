import type { ItemDto, PartyDto } from '@factory-erp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { salesFlows } from '../../../test/sales-flows';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import type { AuthenticatedActor } from '../../platform/actor';
import { BusinessRuleError, ForbiddenError, VersionConflictError } from '../../platform/errors';
import { archiveItem, getItem, listItems, reactivateItem, updateItem } from '../catalog';
import { createInvoiceDraft, issueInvoice, updateInvoiceDraft } from '../sales';
import { archiveParty, getParty, listParties, reactivateParty, updateParty } from './index';

const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
const f = salesFlows(
  () => env,
  () => fx,
  TODAY,
);
const cmd = () => env.services.commands;
const qry = () => env.services.queries;
const owner = () => fx.actors.owner;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const partyEdit = (p: PartyDto, patch: Partial<Record<string, unknown>> = {}) => ({
  partyId: p.id,
  expectedVersion: p.version,
  name: p.name,
  isCustomer: p.isCustomer,
  isSupplier: p.isSupplier,
  gstin: p.gstin,
  stateCode: p.stateCode,
  addressLine1: p.addressLine1,
  city: p.city,
  creditDays: p.creditDays,
  ...patch,
});
const itemEdit = (i: ItemDto, patch: Partial<Record<string, unknown>> = {}) => ({
  itemId: i.id,
  expectedVersion: i.version,
  name: i.name,
  itemType: i.itemType,
  uom: i.uom,
  hsnCode: i.hsnCode,
  defaultSaleRate: i.defaultSaleRate,
  ...patch,
});
const party = (id: string, actor: AuthenticatedActor = owner()) =>
  qry().execute(getParty, { partyId: id }, actor);
const auditOf = (id: string) =>
  env.services.db
    .selectFrom('audit.events')
    .select(['command', 'before', 'after'])
    .where('entityId', '=', id)
    .orderBy('id')
    .execute();

describe('editing parties', () => {
  it('edits details through the bus: new version, before/after audit, code unchanged', async () => {
    const p = await cmd().execute(
      (await import('./index')).createParty,
      { code: 'C-EDIT', name: 'Edit Me', isCustomer: true, isSupplier: false, stateCode: '27' },
      owner(),
    );
    const edited = await cmd().execute(
      updateParty,
      partyEdit(p, { name: 'Edited Name', city: 'Nashik', creditDays: 45, code: 'HACKED' }),
      fx.actors.accountant,
    );
    expect(edited).toMatchObject({
      code: 'C-EDIT',
      name: 'Edited Name',
      city: 'Nashik',
      creditDays: 45,
    });
    expect(edited.version).toBe(p.version + 1);
    const audit = await auditOf(p.id);
    expect(audit.find((e) => e.command === 'parties.update')).toMatchObject({
      command: 'parties.update',
      before: { name: 'Edit Me', city: null },
      after: { name: 'Edited Name', city: 'Nashik' },
    });
  });

  it('refuses a stale version and a GSTIN that belongs to another party', async () => {
    const p = await party(fx.customers.intra.id);
    await expect(
      cmd().execute(updateParty, partyEdit(p, { expectedVersion: p.version + 5 }), owner()),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      cmd().execute(
        updateParty,
        partyEdit(p, { gstin: fx.customers.inter.gstin, stateCode: '24' }),
        owner(),
      ),
    ).rejects.toThrow(/already belongs to C-INTER/);
  });

  it('an issued invoice keeps the customer details it was issued with', async () => {
    const inv = await f.issued('100', { customer: fx.customers.inter });
    const p = await party(fx.customers.inter.id);
    await cmd().execute(
      updateParty,
      partyEdit(p, { name: 'Inter Customer Renamed', addressLine1: 'New Road 1' }),
      owner(),
    );
    const after = await f.invoice(inv.id);
    expect(after.customerName).toBe('Inter Customer');
    expect(JSON.stringify(after)).not.toContain('New Road 1');
    // …while new documents use the new details.
    const next = await f.issued('100', { customer: fx.customers.inter });
    expect(next.customerName).toBe('Inter Customer Renamed');
  });

  it('cannot stop being a customer, or be archived, while business is open', async () => {
    const p0 = await cmd().execute(
      (await import('./index')).createParty,
      {
        code: 'C-OPEN',
        name: 'Open Business',
        isCustomer: true,
        isSupplier: false,
        stateCode: '27',
      },
      owner(),
    );
    const inv = await f.issued('100', { customer: p0 });
    let p = await party(p0.id);
    await expect(
      cmd().execute(archiveParty, { partyId: p.id, expectedVersion: p.version }, owner()),
    ).rejects.toMatchObject({
      rule: 'PARTY_HAS_OPEN_BUSINESS',
    });
    await expect(
      cmd().execute(updateParty, partyEdit(p, { isCustomer: false, isSupplier: true }), owner()),
    ).rejects.toMatchObject({ rule: 'PARTY_HAS_OPEN_BUSINESS' });

    // Settle the invoice: now it can be archived; it leaves the pickers, history stays readable.
    await f.receipt(inv.grandTotal, [{ invoiceId: inv.id, amount: inv.grandTotal }], p.id);
    p = await party(p.id);
    const archived = await cmd().execute(
      archiveParty,
      { partyId: p.id, expectedVersion: p.version },
      owner(),
    );
    expect(archived.status).toBe('ARCHIVED');
    const active = await qry().execute(listParties, { q: 'C-OPEN' }, owner());
    expect(active).toEqual([]);
    const all = await qry().execute(listParties, { q: 'C-OPEN', status: 'archived' }, owner());
    expect(all.map((x) => x.id)).toEqual([p.id]);
    expect((await f.invoice(inv.id)).customerName).toBe('Open Business');
    await expect(
      cmd().execute(
        createInvoiceDraft,
        {
          customerId: p.id,
          invoiceDate: TODAY,
          lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '1' }],
        },
        owner(),
      ),
    ).rejects.toMatchObject({ rule: 'CUSTOMER_ARCHIVED' });

    const back = await cmd().execute(
      reactivateParty,
      { partyId: p.id, expectedVersion: archived.version },
      owner(),
    );
    expect(back.status).toBe('ACTIVE');
    expect((await auditOf(p.id)).map((e) => e.command)).toEqual(
      expect.arrayContaining(['parties.archive', 'parties.reactivate']),
    );
  });

  it('is permission-checked, CONFIRM-tier for the AI, and idempotent', async () => {
    const p = await party(fx.customers.intra.id);
    await expect(cmd().execute(updateParty, partyEdit(p), fx.actors.worker)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      cmd().execute(updateParty, partyEdit(p), asAiAgent(owner())),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const key = 'party-edit-idem-1';
    const once = await cmd().execute(updateParty, partyEdit(p, { city: 'Pune' }), owner(), {
      idempotencyKey: key,
    });
    const twice = await cmd().execute(updateParty, partyEdit(p, { city: 'Pune' }), owner(), {
      idempotencyKey: key,
    });
    expect(twice).toEqual(once);
    expect((await party(p.id)).version).toBe(p.version + 1);
  });
});

describe('editing items', () => {
  const item = (id: string) => qry().execute(getItem, { itemId: id }, owner());

  it('edits an item; issued invoices keep their line snapshot, drafts re-price on save', async () => {
    const issued = await f.issued('100');
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }],
      },
      owner(),
    );
    const before = await item(fx.items.widget.id);
    const edited = await cmd().execute(
      updateItem,
      itemEdit(before, { name: 'Widget Mk II', hsnCode: '4819', code: 'HACKED' }),
      owner(),
    );
    expect(edited).toMatchObject({
      code: before.code,
      name: 'Widget Mk II',
      hsnCode: '4819',
      gstRatePercent: '5',
    });

    const old = await f.invoice(issued.id);
    expect(old.lines[0]).toMatchObject({ hsnCode: '7326', gstRatePercent: '18' });
    const resaved = await cmd().execute(
      updateInvoiceDraft,
      {
        invoiceId: draft.id,
        expectedVersion: draft.version,
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: fx.items.widget.id, quantity: '1', unitRate: '100' }],
      },
      owner(),
    );
    expect(resaved.lines[0]).toMatchObject({ hsnCode: '4819', gstRatePercent: '5' });

    // Restore the fixture item for the other tests.
    await cmd().execute(
      updateItem,
      itemEdit(edited, { name: before.name, hsnCode: '7326' }),
      owner(),
    );
    await cmd().execute(
      issueInvoice,
      { invoiceId: resaved.id, expectedVersion: resaved.version },
      owner(),
    );
  });

  it('cannot archive an item on an open draft; an archived item cannot be invoiced', async () => {
    const it0 = await item(fx.items.carton.id);
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: fx.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: it0.id, quantity: '1', unitRate: '10' }],
      },
      owner(),
    );
    await expect(
      cmd().execute(archiveItem, { itemId: it0.id, expectedVersion: it0.version }, owner()),
    ).rejects.toMatchObject({
      rule: 'ITEM_ON_OPEN_DRAFTS',
    });
    await cmd().execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      owner(),
    );

    const archived = await cmd().execute(
      archiveItem,
      { itemId: it0.id, expectedVersion: it0.version },
      owner(),
    );
    expect(archived.status).toBe('ARCHIVED');
    expect((await qry().execute(listItems, { q: it0.code }, owner())).map((i) => i.id)).toEqual([]);
    await expect(
      cmd().execute(
        createInvoiceDraft,
        {
          customerId: fx.customers.intra.id,
          invoiceDate: TODAY,
          lines: [{ itemId: it0.id, quantity: '1', unitRate: '10' }],
        },
        owner(),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      cmd().execute(archiveItem, { itemId: it0.id, expectedVersion: archived.version }, owner()),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    const back = await cmd().execute(
      reactivateItem,
      { itemId: it0.id, expectedVersion: archived.version },
      owner(),
    );
    expect(back.status).toBe('ACTIVE');
  });

  it('the accountant may edit parties but not items', async () => {
    const i = await item(fx.items.widget.id);
    await expect(
      cmd().execute(updateItem, itemEdit(i), fx.actors.accountant),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

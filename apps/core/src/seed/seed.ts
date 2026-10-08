import { ROLE_CODES, type ItemDto, type PartyDto } from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { AuthenticatedActor } from '../platform/actor';
import { systemActor } from '../platform/actor';
import { writeAudit } from '../platform/audit';
import { addDays, businessDate } from '../platform/clock';
import { uuidv7 } from '../platform/ids';
import { toJsonb } from '../platform/json';
import { DEFAULT_ROLES } from '../platform/roles';
import { createItem } from '../modules/catalog';
import { hashPassword, loadAccess } from '../modules/identity';
import { createParty } from '../modules/parties';
import {
  cancelInvoice,
  createCreditNoteDraft,
  createInvoiceDraft,
  issueCreditNote,
  issueInvoice,
} from '../modules/sales';
import { recordReceipt } from '../modules/receivables';
import type { Services } from '../services';
import {
  DEMO_CANCELLATIONS,
  DEMO_COMPANY,
  DEMO_CREDIT_NOTES,
  DEMO_HSN,
  DEMO_INVOICES,
  DEMO_ITEMS,
  DEMO_PARTIES,
  DEMO_RECEIPTS,
  DEMO_RATE_NOTE,
  DEMO_USERS,
} from './demo-data';

/** Roles and their permissions (code → data). Safe to run repeatedly. */
export async function syncRoles(services: Services): Promise<void> {
  await services.db.transaction().execute(async (tx) => {
    for (const code of ROLE_CODES) {
      const def = DEFAULT_ROLES[code];
      await tx
        .insertInto('identity.roles')
        .values({ code, name: def.name, description: def.description })
        .onConflict((oc) =>
          oc.column('code').doUpdateSet({ name: def.name, description: def.description }),
        )
        .execute();
      await tx.deleteFrom('identity.rolePermissions').where('roleCode', '=', code).execute();
      if (def.permissions.length) {
        await tx
          .insertInto('identity.rolePermissions')
          .values(def.permissions.map((permission) => ({ roleCode: code, permission })))
          .execute();
      }
    }
  });
}

export interface SeedResult {
  seeded: boolean;
  companyId: string;
  invoicesIssued: number;
}

/**
 * Deterministic demo dataset. Content is fixed; invoice dates are relative to "today" so the
 * dashboard always looks alive. Refuses to run in production.
 */
export async function seedDemo(
  services: Services,
  opts: { password: string },
): Promise<SeedResult> {
  if (services.config.env === 'production')
    throw new Error('Refusing to seed demo data in production');
  const { db, clock, logger } = services;

  await syncRoles(services);

  const existing = await db
    .selectFrom('platform.companies')
    .select('id')
    .where('gstin', '=', DEMO_COMPANY.gstin)
    .executeTakeFirst();
  if (existing) {
    logger.info('demo data already present — nothing to do (use --reset to rebuild)');
    return { seeded: false, companyId: existing.id, invoicesIssued: 0 };
  }

  const now = clock.now();
  const companyId = uuidv7(now.getTime());
  const passwordHash = await hashPassword(opts.password);
  const userIds = new Map<string, string>();

  // 1. Bootstrap company, reference data, users and stock (no user exists yet to act).
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('platform.companies')
      .values({
        id: companyId,
        ...DEMO_COMPANY,
        bankDetails: toJsonb(DEMO_COMPANY.bankDetails),
        isDemo: true,
      })
      .execute();

    for (const h of DEMO_HSN) {
      await tx
        .insertInto('catalog.hsnCodes')
        .values({ code: h.code, description: h.description })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await tx
        .insertInto('catalog.gstRates')
        .values({
          id: uuidv7(),
          hsnCode: h.code,
          ratePercent: h.rate,
          effectiveFrom: '2024-04-01',
          sourceNote: DEMO_RATE_NOTE,
          verificationStatus: 'DEMO_UNVERIFIED',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    for (const u of DEMO_USERS) {
      const id = uuidv7();
      userIds.set(u.username, id);
      await tx
        .insertInto('identity.users')
        .values({ id, username: u.username, displayName: u.displayName, passwordHash })
        .execute();
      await tx
        .insertInto('identity.userRoles')
        .values({ userId: id, roleCode: u.role, companyId })
        .execute();
    }

    await writeAudit(
      tx,
      [
        {
          entityType: 'platform.company',
          entityId: companyId,
          after: { legalName: DEMO_COMPANY.legalName, isDemo: true },
        },
      ],
      { actor: systemActor('seed'), command: 'seed.demo.bootstrap', companyId, occurredAt: now },
    );
  });

  // 2. Everything else goes through the command bus as the demo owner.
  const ownerId = userIds.get('owner');
  if (!ownerId) throw new Error('owner user missing');
  const access = await loadAccess(db, ownerId, companyId);
  const owner: AuthenticatedActor = {
    requestId: 'seed',
    actorKind: 'user',
    user: {
      id: ownerId,
      username: 'owner',
      displayName: 'Demo Owner',
      companyId,
      sessionId: uuidv7(),
      roles: access.roles,
      permissions: access.permissions,
      mustChangePassword: false,
    },
  };

  const parties = new Map<string, PartyDto>();
  for (const p of DEMO_PARTIES)
    parties.set(p.code, await services.commands.execute(createParty, p, owner));

  const items = new Map<string, ItemDto>();
  for (const { openingStock: _ignored, ...i } of DEMO_ITEMS)
    items.set(i.code, await services.commands.execute(createItem, i, owner));

  // Opening stock (inventory examples). There is no stock command yet, so this is a direct,
  // audited seed write into the append-only stock ledger.
  const today = businessDate(now);
  await db.transaction().execute(async (tx) => {
    const warehouseId = uuidv7();
    await tx
      .insertInto('inventory.warehouses')
      .values({ id: warehouseId, companyId, code: 'MAIN', name: 'Main Store' })
      .execute();
    const movements = DEMO_ITEMS.filter((i) => i.openingStock).map((i) => ({
      id: uuidv7(),
      companyId,
      itemId: items.get(i.code)?.id ?? '',
      warehouseId,
      movementDate: addDays(today, -30),
      movementType: 'OPENING',
      quantity: i.openingStock ?? '0',
      sourceType: 'demo.seed',
      notes: 'Demo opening stock',
      createdBy: ownerId,
    }));
    await tx.insertInto('inventory.stockMovements').values(movements).execute();
    await writeAudit(
      tx,
      [
        {
          entityType: 'inventory.warehouse',
          entityId: warehouseId,
          after: { openingMovements: movements.length },
        },
      ],
      {
        actor: owner,
        command: 'seed.demo.openingStock',
        companyId,
        occurredAt: now,
      },
    );
  });

  // 3. Invoices: drafts via createDraft, then issue (oldest first so numbering follows dates).
  let invoicesIssued = 0;
  const invoiceIds = new Map<string, string>();
  const invoiceVersions = new Map<string, number>();
  for (const inv of DEMO_INVOICES) {
    const customer = parties.get(inv.customer);
    if (!customer) throw new Error(`unknown demo customer ${inv.customer}`);
    const draft = await services.commands.execute(
      createInvoiceDraft,
      {
        customerId: customer.id,
        invoiceDate: addDays(today, -inv.daysAgo),
        notes: inv.notes ?? null,
        lines: inv.lines.map((l) => ({
          itemId: items.get(l.item)?.id ?? '',
          quantity: l.quantity,
          unitRate: l.unitRate,
          discountPercent: l.discountPercent ?? '0',
        })),
      },
      owner,
    );
    invoiceIds.set(inv.ref, draft.id);
    if (inv.issue) {
      const issued = await services.commands.execute(
        issueInvoice,
        { invoiceId: draft.id, expectedVersion: draft.version },
        owner,
      );
      invoiceVersions.set(inv.ref, issued.version);
      invoicesIssued++;
    }
  }

  // 4. Customer receipts with bill-wise allocation, through the same command as the UI.
  let receiptsRecorded = 0;
  for (const r of DEMO_RECEIPTS) {
    const customer = parties.get(r.customer);
    if (!customer) throw new Error(`unknown demo customer ${r.customer}`);
    await services.commands.execute(
      recordReceipt,
      {
        customerId: customer.id,
        receiptDate: addDays(today, -r.daysAgo),
        amount: r.amount,
        paymentMode: r.paymentMode,
        reference: r.reference,
        notes: 'Demo receipt (synthetic data)',
        allocations: r.allocations.map((a) => {
          const invoiceId = invoiceIds.get(a.invoice);
          if (!invoiceId) throw new Error(`unknown demo invoice ${a.invoice}`);
          return { invoiceId, amount: a.amount };
        }),
      },
      owner,
    );
    receiptsRecorded++;
  }

  // 5. Sales corrections: credit notes (oldest first) and cancellations, through the same
  //    commands as the UI.
  const invoiceIdOf = (ref: string) => {
    const id = invoiceIds.get(ref);
    if (!id) throw new Error(`unknown demo invoice ${ref}`);
    return id;
  };
  let creditNotes = 0;
  for (const cn of DEMO_CREDIT_NOTES) {
    const invoiceId = invoiceIdOf(cn.invoice);
    const customerId = DEMO_INVOICES.find((i) => i.ref === cn.invoice)?.customer;
    const draft = await services.commands.execute(
      createCreditNoteDraft,
      {
        invoiceId,
        customerId: parties.get(customerId ?? '')?.id ?? '',
        creditNoteDate: addDays(today, -cn.daysAgo),
        reasonCode: cn.reasonCode,
        reason: cn.reason,
        lines: [...cn.lines],
      },
      owner,
    );
    if (cn.issue) {
      await services.commands.execute(
        issueCreditNote,
        { creditNoteId: draft.id, expectedVersion: draft.version },
        owner,
      );
    }
    creditNotes++;
  }
  for (const c of DEMO_CANCELLATIONS) {
    await services.commands.execute(
      cancelInvoice,
      {
        invoiceId: invoiceIdOf(c.invoice),
        expectedVersion: invoiceVersions.get(c.invoice) ?? 0,
        reason: c.reason,
      },
      owner,
    );
  }

  await sql`analyze`.execute(db);
  logger.info(
    {
      companyId,
      parties: parties.size,
      items: items.size,
      invoicesIssued,
      receiptsRecorded,
      creditNotes,
      cancellations: DEMO_CANCELLATIONS.length,
    },
    'demo data seeded',
  );
  return { seeded: true, companyId, invoicesIssued };
}

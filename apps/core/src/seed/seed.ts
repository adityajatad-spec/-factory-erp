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
import { createWarehouse, recordStockMovements } from '../modules/inventory';
import { approveBankAccount, createParty, proposeBankAccount } from '../modules/parties';
import { approveSupplierPayment, requestSupplierPayment } from '../modules/payables';
import {
  approvePurchaseOrder,
  closePurchaseOrder,
  createPurchaseInvoiceDraft,
  createPurchaseOrderDraft,
  getPurchaseOrder,
  postPurchaseInvoice,
  recordGoodsReceipt,
  updatePurchaseInvoiceDraft,
} from '../modules/purchasing';
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
  DEMO_BANK_ACCOUNTS,
  DEMO_CANCELLATIONS,
  DEMO_COMPANY,
  DEMO_CREDIT_NOTES,
  DEMO_HSN,
  DEMO_INVOICES,
  DEMO_GOODS_RECEIPTS,
  DEMO_ITEMS,
  DEMO_PARTIES,
  DEMO_PO_CLOSURES,
  DEMO_PURCHASE_INVOICES,
  DEMO_PURCHASE_ORDERS,
  DEMO_RECEIPTS,
  DEMO_SUPPLIER_PAYMENTS,
  DEMO_RATE_NOTE,
  DEMO_USERS,
  DEMO_WAREHOUSES,
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

  // 2. Everything else goes through the command bus, as the demo user whose job it is.
  const actorFor = async (username: string): Promise<AuthenticatedActor> => {
    const id = userIds.get(username);
    const user = DEMO_USERS.find((u) => u.username === username);
    if (!id || !user) throw new Error(`${username} user missing`);
    const access = await loadAccess(db, id, companyId);
    return {
      requestId: 'seed',
      actorKind: 'user',
      user: {
        id,
        username,
        displayName: user.displayName,
        companyId,
        sessionId: uuidv7(),
        roles: access.roles,
        permissions: access.permissions,
        mustChangePassword: false,
      },
    };
  };
  const owner = await actorFor('owner');
  const ownerId = owner.user.id;

  const parties = new Map<string, PartyDto>();
  for (const p of DEMO_PARTIES)
    parties.set(p.code, await services.commands.execute(createParty, p, owner));

  const items = new Map<string, ItemDto>();
  for (const { openingStock: _ignored, ...i } of DEMO_ITEMS)
    items.set(i.code, await services.commands.execute(createItem, i, owner));

  // Warehouses through the command bus; opening balances through the inventory module's API
  // (there is deliberately no "opening stock" command), audited as a seed step.
  const warehouses = new Map<string, string>();
  for (const w of DEMO_WAREHOUSES) {
    warehouses.set(w.code, (await services.commands.execute(createWarehouse, w, owner)).id);
  }
  const mainWarehouse = warehouses.get('MAIN') ?? '';
  const today = businessDate(now);
  await db.transaction().execute(async (tx) => {
    const batchId = uuidv7();
    const movements = await recordStockMovements(tx, {
      companyId,
      movementDate: addDays(today, -30),
      movementType: 'OPENING',
      source: { type: 'inventory.opening', id: batchId, reference: 'Opening stock' },
      lines: DEMO_ITEMS.filter((i) => i.openingStock).map((i, n) => ({
        lineNo: n + 1,
        itemId: items.get(i.code)?.id ?? '',
        warehouseId: mainWarehouse,
        quantity: i.openingStock ?? '0',
      })),
      notes: 'Demo opening stock',
      userId: ownerId,
      now,
    });
    await writeAudit(
      tx,
      [
        {
          entityType: 'inventory.opening',
          entityId: batchId,
          after: { movements: movements.length },
        },
      ],
      { actor: owner, command: 'seed.demo.openingStock', companyId, occurredAt: now },
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

  // 6. Procure-to-pay, each step by the person whose job it is (maker ≠ checker).
  const procurement = await seedProcurement(services, {
    today,
    actorFor,
    partyId: (code) => parties.get(code)?.id ?? '',
    itemId: (code) => items.get(code)?.id ?? '',
    warehouseId: (code) => warehouses.get(code) ?? '',
  });

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
      ...procurement,
    },
    'demo data seeded',
  );
  return { seeded: true, companyId, invoicesIssued };
}

/**
 * Demo purchasing: POs (drafted by the purchase manager, approved by the owner), goods received
 * by the supervisor, supplier bills entered and posted by the accountant (the owner accepts the
 * one that does not match), payments requested by the accountant and approved by the owner,
 * and supplier bank details proposed by the accountant and approved by the owner.
 */
async function seedProcurement(
  services: Services,
  ctx: {
    today: string;
    actorFor: (username: string) => Promise<AuthenticatedActor>;
    partyId: (code: string) => string;
    itemId: (code: string) => string;
    warehouseId: (code: string) => string;
  },
) {
  const c = services.commands;
  const [owner, accountant, purchase, supervisor] = await Promise.all(
    ['owner', 'accountant', 'purchase', 'supervisor'].map(ctx.actorFor),
  );
  if (!owner || !accountant || !purchase || !supervisor) throw new Error('demo users missing');
  const day = (daysAgo: number) => addDays(ctx.today, -daysAgo);

  const orders = new Map<string, string>();
  for (const po of DEMO_PURCHASE_ORDERS) {
    const draft = await c.execute(
      createPurchaseOrderDraft,
      {
        supplierId: ctx.partyId(po.supplier),
        warehouseId: ctx.warehouseId(po.warehouse),
        poDate: day(po.daysAgo),
        expectedDate: day(po.daysAgo - po.leadDays),
        notes: po.notes ?? null,
        lines: po.lines.map((l) => ({ ...l, itemId: ctx.itemId(l.item) })),
      },
      purchase,
    );
    orders.set(po.ref, draft.id);
    if (po.approve) {
      await c.execute(
        approvePurchaseOrder,
        { orderId: draft.id, expectedVersion: draft.version },
        owner,
      );
    }
  }
  const orderOf = (ref: string) => {
    const id = orders.get(ref);
    if (!id) throw new Error(`unknown demo order ${ref}`);
    return id;
  };

  for (const g of DEMO_GOODS_RECEIPTS) {
    await c.execute(
      recordGoodsReceipt,
      {
        orderId: orderOf(g.order),
        receiptDate: day(g.daysAgo),
        supplierReference: g.supplierReference,
        lines: g.lines.map((l) => ({ ...l, rejectedQuantity: l.rejectedQuantity ?? '0' })),
      },
      supervisor,
    );
  }

  for (const cl of DEMO_PO_CLOSURES) {
    const order = await services.queries.execute(
      getPurchaseOrder,
      { orderId: orderOf(cl.order) },
      owner,
    );
    await c.execute(
      closePurchaseOrder,
      { orderId: order.id, expectedVersion: order.version, reason: cl.reason },
      owner,
    );
  }

  const bills = new Map<string, { id: string; grandTotal: string }>();
  for (const b of DEMO_PURCHASE_INVOICES) {
    const body = {
      supplierId: ctx.partyId(b.supplier),
      orderId: b.order ? orderOf(b.order) : null,
      supplierInvoiceNumber: b.supplierInvoiceNumber,
      invoiceDate: day(b.daysAgo),
      notes: null,
      lines: b.lines.map((l, i) => ({
        ...l,
        itemId: ctx.itemId(l.item),
        orderLineNo: b.order ? i + 1 : null,
      })),
    };
    const first = await c.execute(
      createPurchaseInvoiceDraft,
      { ...body, supplierStatedTotal: '0.00' },
      accountant,
    );
    // The printed total on the (synthetic) bill is what the shared GST engine computes.
    const draft = await c.execute(
      updatePurchaseInvoiceDraft,
      {
        ...body,
        invoiceId: first.id,
        expectedVersion: first.version,
        supplierStatedTotal: first.grandTotal,
      },
      accountant,
    );
    bills.set(b.ref, { id: draft.id, grandTotal: draft.grandTotal });
    if (b.post) {
      await c.execute(
        postPurchaseInvoice,
        {
          invoiceId: draft.id,
          expectedVersion: draft.version,
          matchOverrideReason: b.overrideReason ?? null,
        },
        b.overrideReason ? owner : accountant,
      );
    }
  }
  const billOf = (ref: string) => {
    const bill = bills.get(ref);
    if (!bill) throw new Error(`unknown demo bill ${ref}`);
    return bill;
  };

  let paymentsApproved = 0;
  for (const p of DEMO_SUPPLIER_PAYMENTS) {
    const allocations = p.allocations.map((a) => ({
      purchaseInvoiceId: billOf(a.bill).id,
      amount: a.amount === 'FULL' ? billOf(a.bill).grandTotal : a.amount,
    }));
    const requested = await c.execute(
      requestSupplierPayment,
      {
        supplierId: ctx.partyId(p.supplier),
        paymentDate: day(p.daysAgo),
        amount: p.amount === 'FULL' ? (allocations[0]?.amount ?? '0') : p.amount,
        paymentMode: p.paymentMode,
        reference: p.reference,
        notes: 'Demo supplier payment (synthetic data)',
        allocations,
      },
      accountant,
    );
    if (p.approve) {
      await c.execute(
        approveSupplierPayment,
        { paymentId: requested.id, expectedVersion: requested.version },
        owner,
      );
      paymentsApproved++;
    }
  }

  for (const b of DEMO_BANK_ACCOUNTS) {
    const proposed = await c.execute(
      proposeBankAccount,
      {
        partyId: ctx.partyId(b.supplier),
        accountHolderName: b.accountHolderName,
        accountNumber: b.accountNumber,
        ifsc: b.ifsc,
        bankName: b.bankName,
        changeReason: "Supplier's letter on letterhead (demo)",
      },
      accountant,
    );
    if (b.approve) {
      await c.execute(
        approveBankAccount,
        { bankAccountId: proposed.id, expectedVersion: proposed.version },
        owner,
      );
    }
  }

  return {
    purchaseOrders: orders.size,
    goodsReceipts: DEMO_GOODS_RECEIPTS.length,
    purchaseInvoices: bills.size,
    supplierPaymentsApproved: paymentsApproved,
  };
}

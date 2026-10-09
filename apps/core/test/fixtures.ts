import type { ItemDto, PartyDto, RoleCode, WarehouseDto } from '@factory-erp/contracts';
import type { AuthenticatedActor } from '../src/platform/actor';
import { uuidv7 } from '../src/platform/ids';
import { toJsonb } from '../src/platform/json';
import { createItem } from '../src/modules/catalog/commands';
import { hashPassword } from '../src/modules/identity/password';
import { loadAccess } from '../src/modules/identity/sessions';
import { createParty } from '../src/modules/parties/commands';
import { createWarehouse } from '../src/modules/inventory';
import { syncRoles } from '../src/seed/seed';
import type { Services } from '../src/services';

export const TEST_PASSWORD = 'correct horse battery staple';

export interface Fixture {
  companyId: string;
  actors: Record<
    'owner' | 'admin' | 'accountant' | 'worker' | 'purchase' | 'supervisor',
    AuthenticatedActor
  >;
  customers: { intra: PartyDto; inter: PartyDto };
  items: { widget: ItemDto; carton: ItemDto; rawMaterial: ItemDto };
  /** Suppliers in the company's state (CGST + SGST) and in another state (IGST). */
  suppliers: { local: PartyDto; outstation: PartyDto };
  /** The store purchases are delivered to. */
  warehouse: WarehouseDto;
}

/**
 * Minimal synthetic company: roles, three users, two customers (intra/inter-state), items.
 * A `tag` makes a second, independent company in the same database (usernames, names and the
 * company GSTIN carry the tag; party and item codes repeat on purpose — they are per company).
 */
export async function createFixture(
  services: Services,
  opts: { tag?: string } = {},
): Promise<Fixture> {
  const { db } = services;
  const tag = opts.tag ? ` ${opts.tag}` : '';
  const userSuffix = opts.tag ? `-${opts.tag}` : '';
  await syncRoles(services);
  const companyId = uuidv7();
  const passwordHash = await hashPassword(TEST_PASSWORD);

  await db
    .insertInto('platform.companies')
    .values({
      id: companyId,
      legalName: `Test Works${tag} Pvt Ltd`,
      gstin: `27TEST${(opts.tag?.[0] ?? 'o').toUpperCase()}0001A1Z1`,
      stateCode: '27',
      addressLine1: 'Test Road',
      city: 'Pune',
      postalCode: '411000',
      bankDetails: toJsonb({
        bankName: 'Test Bank',
        accountName: 'Test Works',
        accountNumber: '0001',
        ifsc: 'TEST0000001',
      }),
      isDemo: true,
    })
    .execute();

  for (const [code, rate] of [
    ['7326', '18'],
    ['4819', '5'],
    ['7208', '18'],
  ] as const) {
    // HSN codes and rates are national reference data, shared by every company.
    const added = await db
      .insertInto('catalog.hsnCodes')
      .values({ code, description: `HSN ${code}` })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning('code')
      .executeTakeFirst();
    if (!added) continue;
    await db
      .insertInto('catalog.gstRates')
      .values({
        id: uuidv7(),
        hsnCode: code,
        ratePercent: rate,
        effectiveFrom: '2020-04-01',
        sourceNote: 'test',
        verificationStatus: 'DEMO_UNVERIFIED',
      })
      .execute();
  }

  const actor = async (name: string, role: RoleCode): Promise<AuthenticatedActor> => {
    const id = uuidv7();
    const username = `${name}${userSuffix}`;
    await db
      .insertInto('identity.users')
      .values({ id, username, displayName: username, passwordHash })
      .execute();
    await db
      .insertInto('identity.userRoles')
      .values({ userId: id, roleCode: role, companyId })
      .execute();
    const access = await loadAccess(db, id, companyId);
    return {
      requestId: `test-${username}`,
      actorKind: 'user',
      user: {
        id,
        username,
        displayName: username,
        companyId,
        sessionId: uuidv7(),
        roles: access.roles,
        permissions: access.permissions,
        mustChangePassword: false,
      },
    };
  };
  const actors = {
    owner: await actor('owner', 'OWNER'),
    // A second person with full access: the checker for maker-checker flows.
    admin: await actor('admin', 'ADMIN'),
    accountant: await actor('accountant', 'ACCOUNTANT'),
    worker: await actor('worker', 'WORKER'),
    purchase: await actor('purchase', 'PURCHASE_MANAGER'),
    supervisor: await actor('supervisor', 'SUPERVISOR'),
  };

  const c = services.commands;
  const intra = await c.execute(
    createParty,
    {
      code: 'C-INTRA',
      name: `Intra Customer${tag}`,
      isCustomer: true,
      isSupplier: false,
      gstin: '27TESTO0002B1Z2',
      stateCode: '27',
    },
    actors.owner,
  );
  const inter = await c.execute(
    createParty,
    {
      code: 'C-INTER',
      name: `Inter Customer${tag}`,
      isCustomer: true,
      isSupplier: false,
      gstin: '24TESTO0003C1Z3',
      stateCode: '24',
    },
    actors.owner,
  );
  const widget = await c.execute(
    createItem,
    {
      code: 'W-1',
      name: `Widget${tag}`,
      itemType: 'FINISHED_GOOD',
      uom: 'NOS',
      hsnCode: '7326',
      defaultSaleRate: '100',
    },
    actors.owner,
  );
  const carton = await c.execute(
    createItem,
    { code: 'CTN', name: `Carton${tag}`, itemType: 'COMPONENT', uom: 'NOS', hsnCode: '4819' },
    actors.owner,
  );
  const rawMaterial = await c.execute(
    createItem,
    {
      code: 'RM-1',
      name: `Steel Sheet${tag}`,
      itemType: 'RAW_MATERIAL',
      uom: 'KGS',
      hsnCode: '7208',
    },
    actors.owner,
  );

  const supplier = (code: string, name: string, gstin: string, stateCode: string) =>
    c.execute(
      createParty,
      {
        code,
        name: `${name}${tag}`,
        isCustomer: false,
        isSupplier: true,
        gstin,
        stateCode,
        creditDays: 30,
      },
      actors.owner,
    );
  const local = await supplier('S-LOCAL', 'Local Steel Supplier', '27TESTO0004D1Z4', '27');
  const outstation = await supplier('S-OUT', 'Outstation Packaging', '24TESTO0005E1Z5', '24');
  const warehouse = await c.execute(
    createWarehouse,
    { code: 'STORE', name: `Stores${tag}` },
    actors.owner,
  );

  return {
    companyId,
    actors,
    customers: { intra, inter },
    items: { widget, carton, rawMaterial },
    suppliers: { local, outstation },
    warehouse,
  };
}

/** An actor identical to `user` but acting through the (future) AI copilot. */
export function asAiAgent(actor: AuthenticatedActor): AuthenticatedActor {
  return { ...actor, actorKind: 'ai_agent', aiSessionId: uuidv7() };
}

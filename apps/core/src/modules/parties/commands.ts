import {
  CreatePartyRequest,
  PartyStatusRequest,
  PERMISSIONS,
  UpdatePartyRequest,
  type PartyDto,
} from '@factory-erp/contracts';
import { formatINR, Money } from '@factory-erp/money';
import type { z } from 'zod';
import type { DbTransaction } from '../../db/database';
import { defineCommand, type CommandContext, type CommandOutcome } from '../../platform/commands';
import {
  BusinessRuleError,
  DuplicateError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { selectParties, toPartyDto } from './party-dto';

async function assertKnownState(tx: DbTransaction, stateCode: string): Promise<void> {
  const state = await tx
    .selectFrom('platform.states')
    .select('code')
    .where('code', '=', stateCode)
    .executeTakeFirst();
  if (!state) throw new BusinessRuleError('UNKNOWN_STATE', `Unknown state code ${stateCode}`);
}

/** Lock a party for change and check the caller saw its latest version. */
async function lockParty(
  tx: DbTransaction,
  companyId: string,
  partyId: string,
  expectedVersion: number,
): Promise<PartyDto> {
  const row = await selectParties(tx, companyId, true)
    .where('p.id', '=', partyId)
    .forUpdate('p')
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Party');
  if (row.version !== expectedVersion) throw new VersionConflictError('Party');
  return toPartyDto(row);
}

/**
 * What still ties a party to open business as a customer: drafts that would be issued to it,
 * and money owed by or to it. Reads sales and finance tables (reads may cross modules).
 */
async function openCustomerBusiness(
  tx: DbTransaction,
  companyId: string,
  party: PartyDto,
): Promise<string[]> {
  const drafts = await tx
    .selectFrom('sales.invoices')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('companyId', '=', companyId)
    .where('customerId', '=', party.id)
    .where('status', '=', 'DRAFT')
    .executeTakeFirstOrThrow();
  const creditDrafts = await tx
    .selectFrom('sales.creditNotes')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('companyId', '=', companyId)
    .where('customerId', '=', party.id)
    .where('status', '=', 'DRAFT')
    .executeTakeFirstOrThrow();
  const reasons: string[] = [];
  if (Number(drafts.n)) reasons.push(`${drafts.n} draft invoice(s)`);
  if (Number(creditDrafts.n)) reasons.push(`${creditDrafts.n} draft credit note(s)`);
  const balance = Money.of(party.receivableBalance ?? '0');
  if (!balance.isZero()) {
    reasons.push(
      balance.isNegative()
        ? `${formatINR(balance.negated())} received but not yet allocated`
        : `${formatINR(balance)} still receivable`,
    );
  }
  return reasons;
}

const auditView = (p: PartyDto) => ({ ...p, receivableBalance: undefined });

export const createParty = defineCommand({
  name: 'parties.create',
  description: 'Create a customer and/or supplier.',
  input: CreatePartyRequest,
  permission: PERMISSIONS.partyCreate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    await assertKnownState(tx, input.stateCode);

    const clash = await tx
      .selectFrom('party.parties')
      .select(['code', 'gstin'])
      .where('companyId', '=', companyId)
      .where((eb) =>
        eb.or([
          eb('code', '=', input.code),
          ...(input.gstin ? [eb('gstin', '=', input.gstin)] : []),
        ]),
      )
      .executeTakeFirst();
    if (clash?.code === input.code)
      throw new DuplicateError(`Party code ${input.code} is already in use`);
    if (clash) throw new DuplicateError(`A party with GSTIN ${input.gstin ?? ''} already exists`);

    const id = uuidv7(now.getTime());
    await tx
      .insertInto('party.parties')
      .values({
        id,
        companyId,
        code: input.code,
        name: input.name,
        isCustomer: input.isCustomer,
        isSupplier: input.isSupplier,
        gstin: input.gstin,
        stateCode: input.stateCode,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        postalCode: input.postalCode,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        creditDays: input.creditDays,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();

    const party: PartyDto = toPartyDto(
      await selectParties(tx, companyId, false).where('p.id', '=', id).executeTakeFirstOrThrow(),
    );
    return {
      result: party,
      audit: [
        { entityType: 'party', entityId: id, after: { ...party, receivableBalance: undefined } },
      ],
    };
  },
});

export const updateParty = defineCommand({
  name: 'parties.update',
  description:
    'Edit a customer or supplier (name, GSTIN, state, address, contact, credit days, roles). The code cannot change; issued documents keep the details they were issued with.',
  input: UpdatePartyRequest,
  permission: PERMISSIONS.partyUpdate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockParty(tx, companyId, input.partyId, input.expectedVersion);
    await assertKnownState(tx, input.stateCode);
    if (input.gstin) {
      const clash = await tx
        .selectFrom('party.parties')
        .select('code')
        .where('companyId', '=', companyId)
        .where('gstin', '=', input.gstin)
        .where('id', '<>', before.id)
        .executeTakeFirst();
      if (clash) throw new DuplicateError(`GSTIN ${input.gstin} already belongs to ${clash.code}`);
    }
    if (before.isCustomer && !input.isCustomer) {
      const open = await openCustomerBusiness(tx, companyId, before);
      if (open.length) {
        throw new BusinessRuleError(
          'PARTY_HAS_OPEN_BUSINESS',
          `${before.name} is still a customer in ${open.join(', ')}; settle or clear that first`,
        );
      }
    }

    await tx
      .updateTable('party.parties')
      .set({
        name: input.name,
        isCustomer: input.isCustomer,
        isSupplier: input.isSupplier,
        gstin: input.gstin,
        stateCode: input.stateCode,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        postalCode: input.postalCode,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        creditDays: input.creditDays,
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();

    const after = toPartyDto(
      await selectParties(tx, companyId, false)
        .where('p.id', '=', before.id)
        .executeTakeFirstOrThrow(),
    );
    return {
      result: after,
      audit: [
        {
          entityType: 'party',
          entityId: before.id,
          before: auditView(before),
          after: auditView(after),
        },
      ],
    };
  },
});

/** Archive or reactivate: shared by the two commands below. */
async function setPartyStatus(
  { tx, actor, companyId, now }: CommandContext,
  input: z.output<typeof PartyStatusRequest>,
  target: 'ARCHIVED' | 'ACTIVE',
): Promise<CommandOutcome<PartyDto>> {
  const archiving = target === 'ARCHIVED';
  const before = await lockParty(tx, companyId, input.partyId, input.expectedVersion);
  if (before.status === target) {
    throw new BusinessRuleError(
      archiving ? 'PARTY_ALREADY_ARCHIVED' : 'PARTY_ALREADY_ACTIVE',
      `${before.name} is already ${archiving ? 'archived' : 'active'}`,
    );
  }
  if (archiving) {
    const open = await openCustomerBusiness(tx, companyId, before);
    if (open.length) {
      throw new BusinessRuleError(
        'PARTY_HAS_OPEN_BUSINESS',
        `${before.name} cannot be archived while it has ${open.join(', ')}`,
      );
    }
  }
  await tx
    .updateTable('party.parties')
    .set({
      status: target,
      version: before.version + 1,
      updatedAt: now,
      updatedBy: actor.user.id,
    })
    .where('id', '=', before.id)
    .execute();
  const after = toPartyDto(
    await selectParties(tx, companyId, false)
      .where('p.id', '=', before.id)
      .executeTakeFirstOrThrow(),
  );
  return {
    result: after,
    audit: [
      {
        entityType: 'party',
        entityId: before.id,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version },
      },
    ],
  };
}

export const archiveParty = defineCommand({
  name: 'parties.archive',
  description:
    'Archive a party no longer in use. It disappears from pickers but nothing is deleted; refused while it has drafts or an open balance.',
  input: PartyStatusRequest,
  permission: PERMISSIONS.partyUpdate,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => setPartyStatus(ctx, input, 'ARCHIVED'),
});

export const reactivateParty = defineCommand({
  name: 'parties.reactivate',
  description: 'Reactivate an archived party so it can be used again.',
  input: PartyStatusRequest,
  permission: PERMISSIONS.partyUpdate,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => setPartyStatus(ctx, input, 'ACTIVE'),
});

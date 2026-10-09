import {
  ListBankAccountsQuery,
  ListPartiesQuery,
  PERMISSIONS,
  Uuid,
  type PartyDto,
  type RestrictedBankAccountDto,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { NotFoundError } from '../../platform/errors';
import { defineQuery } from '../../platform/queries';
import { selectBankAccounts, toRestrictedDto } from './bank-account-dto';
import { selectParties, toPartyDto } from './party-dto';

export const listParties = defineQuery({
  name: 'parties.list',
  description: 'Search customers and suppliers by name, code or GSTIN.',
  input: ListPartiesQuery,
  permission: PERMISSIONS.partyRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    { description: 'Find a customer by name', input: { q: 'Sharma', role: 'customer' } },
    { description: 'Archived suppliers', input: { role: 'supplier', status: 'archived' } },
  ],
  handler: async ({ db, companyId, can }, input): Promise<PartyDto[]> => {
    let q = selectParties(db, companyId, can(PERMISSIONS.receivablesRead));
    if (input.status === 'active') q = q.where('p.status', '=', 'ACTIVE');
    if (input.status === 'archived') q = q.where('p.status', '=', 'ARCHIVED');
    if (input.role === 'customer') q = q.where('p.isCustomer', '=', true);
    if (input.role === 'supplier') q = q.where('p.isSupplier', '=', true);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('p.name', 'ilike', like),
          eb('p.code', 'ilike', like),
          eb('p.gstin', 'ilike', like),
        ]),
      );
    }
    const rows = await q.orderBy('p.name').limit(input.limit).execute();
    return rows.map(toPartyDto);
  },
});

export const getParty = defineQuery({
  name: 'parties.get',
  description: 'Get one customer or supplier.',
  input: z.object({ partyId: Uuid }),
  permission: PERMISSIONS.partyRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: async ({ db, companyId, can }, input): Promise<PartyDto> => {
    const row = await selectParties(db, companyId, can(PERMISSIONS.receivablesRead))
      .where('p.id', '=', input.partyId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Party');
    return toPartyDto(row);
  },
});

export const listBankAccounts = defineQuery({
  name: 'parties.bankAccounts.list',
  description:
    "A supplier's bank details, every version (active, pending, superseded, rejected), with full account numbers.",
  input: ListBankAccountsQuery,
  permission: PERMISSIONS.partyBankRead,
  ai: { tier: 'FORBIDDEN' },
  dataClass: 'RESTRICTED',
  handler: async ({ db, companyId }, input): Promise<RestrictedBankAccountDto[]> => {
    const party = await db
      .selectFrom('party.parties')
      .select('id')
      .where('companyId', '=', companyId)
      .where('id', '=', input.partyId)
      .executeTakeFirst();
    if (!party) throw new NotFoundError('Party');
    // The details in use first, then the one awaiting approval, then history (newest first).
    const rows = await selectBankAccounts(db, companyId)
      .where('b.partyId', '=', party.id)
      .orderBy(sql`case b.status when 'ACTIVE' then 0 when 'PENDING_APPROVAL' then 1 else 2 end`)
      .orderBy('b.requestedAt', 'desc')
      .orderBy('b.id', 'desc')
      .execute();
    return rows.map(toRestrictedDto);
  },
});

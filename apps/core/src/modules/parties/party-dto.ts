import type { PartyDto } from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';

/** Base select for parties, joined to state names; optionally with receivable balance. */
export function selectParties(db: DbExecutor, companyId: string, withBalance: boolean) {
  return db
    .selectFrom('party.parties as p')
    .innerJoin('platform.states as s', 's.code', 'p.stateCode')
    .select([
      'p.id',
      'p.code',
      'p.name',
      'p.isCustomer',
      'p.isSupplier',
      'p.gstin',
      'p.stateCode',
      's.name as stateName',
      'p.addressLine1',
      'p.addressLine2',
      'p.city',
      'p.postalCode',
      'p.contactName',
      'p.phone',
      'p.email',
      'p.creditDays',
      'p.status',
      'p.version',
    ])
    .select(
      withBalance
        ? sql<string>`(select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text
                         from finance.party_ledger_entries l where l.party_id = ${sql.ref('p.id')})`.as(
            'receivableBalance',
          )
        : sql<string | null>`null`.as('receivableBalance'),
    )
    .where('p.companyId', '=', companyId);
}

type PartyRow = Awaited<ReturnType<ReturnType<typeof selectParties>['executeTakeFirstOrThrow']>>;

export function toPartyDto(row: PartyRow): PartyDto {
  return {
    ...row,
    status: row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    receivableBalance: row.receivableBalance ?? null,
  };
}

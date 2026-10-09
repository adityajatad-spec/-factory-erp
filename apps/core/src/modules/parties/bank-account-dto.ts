import type {
  BankAccountDto,
  BankAccountStatus,
  RestrictedBankAccountDto,
} from '@factory-erp/contracts';
import type { DbExecutor } from '../../db/database';
import { NotFoundError } from '../../platform/errors';

export const maskAccountNumber = (n: string) =>
  `${'X'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;

export function selectBankAccounts(db: DbExecutor, companyId: string) {
  return db
    .selectFrom('party.bankAccounts as b')
    .innerJoin('identity.users as ur', 'ur.id', 'b.requestedBy')
    .leftJoin('identity.users as ua', 'ua.id', 'b.approvedBy')
    .leftJoin('identity.users as uj', 'uj.id', 'b.rejectedBy')
    .selectAll('b')
    .select([
      'ur.displayName as requestedByName',
      'ua.displayName as approvedByName',
      'uj.displayName as rejectedByName',
    ])
    .where('b.companyId', '=', companyId);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectBankAccounts>['execute']>>[number];

export function toRestrictedDto(r: Row): RestrictedBankAccountDto {
  return {
    id: r.id,
    partyId: r.partyId,
    status: r.status as BankAccountStatus,
    accountHolderName: r.accountHolderName,
    accountNumber: r.accountNumber,
    accountNumberMasked: maskAccountNumber(r.accountNumber),
    ifsc: r.ifsc,
    bankName: r.bankName,
    branch: r.branch,
    changeReason: r.changeReason,
    requestedAt: r.requestedAt.toISOString(),
    requestedById: r.requestedBy,
    requestedByName: r.requestedByName,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedByName: r.approvedByName,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    rejectedByName: r.rejectedByName,
    rejectionReason: r.rejectionReason,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    version: r.version,
  };
}

/** The masked view: what commands return and what may be stored (idempotency replies). */
function toMaskedDto(r: Row): BankAccountDto {
  const { accountNumber: _restricted, ...masked } = toRestrictedDto(r);
  return masked;
}

export async function loadMaskedBankAccount(db: DbExecutor, companyId: string, id: string) {
  const row = await selectBankAccounts(db, companyId).where('b.id', '=', id).executeTakeFirst();
  if (!row) throw new NotFoundError('Bank details');
  return toMaskedDto(row);
}

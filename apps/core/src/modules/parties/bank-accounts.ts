import {
  BankAccountDecisionRequest,
  PERMISSIONS,
  ProposeBankAccountRequest,
  RejectBankAccountRequest,
  type BankAccountDto,
} from '@factory-erp/contracts';
import type { DbTransaction } from '../../db/database';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { loadMaskedBankAccount } from './bank-account-dto';

/**
 * Supplier bank details — RESTRICTED data under maker-checker (docs/ARCHITECTURE.md threat
 * #11, supplier bank-detail fraud). Every operation is FORBIDDEN to the AI. Command results and
 * audit records carry only the masked number; the full number is returned only by the
 * RESTRICTED query, to holders of party.bank.read.
 */

/** What the audit trail records about bank details: never the full number. */
const auditView = (b: BankAccountDto) => ({
  partyId: b.partyId,
  status: b.status,
  accountHolderName: b.accountHolderName,
  accountNumberMasked: b.accountNumberMasked,
  ifsc: b.ifsc,
  bankName: b.bankName,
});

export const proposeBankAccount = defineCommand({
  name: 'parties.bankAccount.propose',
  description:
    'Propose new or changed bank details for a supplier; a different person must approve them before they are used.',
  input: ProposeBankAccountRequest,
  permission: PERMISSIONS.partyBankRequest,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const party = await tx
      .selectFrom('party.parties')
      .select(['id', 'name', 'isSupplier'])
      .where('companyId', '=', companyId)
      .where('id', '=', input.partyId)
      .executeTakeFirst();
    if (!party) throw new NotFoundError('Party');
    if (!party.isSupplier) {
      throw new BusinessRuleError(
        'NOT_A_SUPPLIER',
        `${party.name} is not a supplier; bank details are kept for suppliers only`,
      );
    }
    const pending = await tx
      .selectFrom('party.bankAccounts')
      .select('id')
      .where('partyId', '=', party.id)
      .where('status', '=', 'PENDING_APPROVAL')
      .executeTakeFirst();
    if (pending) {
      throw new BusinessRuleError(
        'BANK_DETAILS_PENDING',
        `A change to ${party.name}'s bank details is already waiting for approval`,
      );
    }
    const id = uuidv7(now.getTime());
    await tx
      .insertInto('party.bankAccounts')
      .values({
        id,
        companyId,
        partyId: party.id,
        status: 'PENDING_APPROVAL',
        accountHolderName: input.accountHolderName,
        accountNumber: input.accountNumber,
        ifsc: input.ifsc,
        bankName: input.bankName,
        branch: input.branch,
        changeReason: input.changeReason,
        requestedAt: now,
        requestedBy: actor.user.id,
      })
      .execute();
    const result = await loadMaskedBankAccount(tx, companyId, id);
    return {
      result,
      audit: [
        {
          entityType: 'party.bank_account',
          entityId: id,
          after: { ...auditView(result), changeReason: input.changeReason },
        },
      ],
    };
  },
});

async function lockPending(
  tx: DbTransaction,
  companyId: string,
  id: string,
  expectedVersion: number,
) {
  const row = await tx
    .selectFrom('party.bankAccounts')
    .select(['id', 'partyId', 'status', 'requestedBy', 'version'])
    .where('companyId', '=', companyId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Bank details');
  if (row.version !== expectedVersion) throw new VersionConflictError('Bank details');
  if (row.status !== 'PENDING_APPROVAL') {
    throw new BusinessRuleError(
      'BANK_DETAILS_NOT_PENDING',
      `These bank details are already ${row.status}`,
    );
  }
  return row;
}

export const approveBankAccount = defineCommand({
  name: 'parties.bankAccount.approve',
  description:
    "Approve someone else's proposed supplier bank details; the previous details are superseded.",
  input: BankAccountDecisionRequest,
  permission: PERMISSIONS.partyBankApprove,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const row = await lockPending(tx, companyId, input.bankAccountId, input.expectedVersion);
    if (row.requestedBy === actor.user.id) {
      throw new BusinessRuleError(
        'SELF_APPROVAL',
        'You proposed these bank details; a different person must approve them',
      );
    }
    const previous = await tx
      .updateTable('party.bankAccounts')
      .set({ status: 'SUPERSEDED', supersededAt: now })
      .where('partyId', '=', row.partyId)
      .where('status', '=', 'ACTIVE')
      .returning('id')
      .executeTakeFirst();
    await tx
      .updateTable('party.bankAccounts')
      .set({
        status: 'ACTIVE',
        approvedAt: now,
        approvedBy: actor.user.id,
        version: row.version + 1,
      })
      .where('id', '=', row.id)
      .execute();
    const result = await loadMaskedBankAccount(tx, companyId, row.id);
    return {
      result,
      audit: [
        {
          entityType: 'party.bank_account',
          entityId: row.id,
          before: { status: 'PENDING_APPROVAL' },
          after: { ...auditView(result), requestedBy: row.requestedBy, approvedBy: actor.user.id },
        },
        ...(previous
          ? [
              {
                entityType: 'party.bank_account',
                entityId: previous.id,
                before: { status: 'ACTIVE' },
                after: { status: 'SUPERSEDED', supersededBy: row.id },
              },
            ]
          : []),
      ],
    };
  },
});

export const rejectBankAccount = defineCommand({
  name: 'parties.bankAccount.reject',
  description: 'Reject proposed supplier bank details, with a reason.',
  input: RejectBankAccountRequest,
  permission: PERMISSIONS.partyBankApprove,
  ai: { tier: 'FORBIDDEN' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const row = await lockPending(tx, companyId, input.bankAccountId, input.expectedVersion);
    await tx
      .updateTable('party.bankAccounts')
      .set({
        status: 'REJECTED',
        rejectedAt: now,
        rejectedBy: actor.user.id,
        rejectionReason: input.reason,
        version: row.version + 1,
      })
      .where('id', '=', row.id)
      .execute();
    const result = await loadMaskedBankAccount(tx, companyId, row.id);
    return {
      result,
      audit: [
        {
          entityType: 'party.bank_account',
          entityId: row.id,
          before: { status: 'PENDING_APPROVAL' },
          after: { ...auditView(result), reason: input.reason },
        },
      ],
    };
  },
});

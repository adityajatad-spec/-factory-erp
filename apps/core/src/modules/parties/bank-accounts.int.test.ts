import type { BankAccountDto, ProposeBankAccountRequest } from '@factory-erp/contracts';
import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import { loggerOptions } from '../../logger';
import type { AuthenticatedActor } from '../../platform/actor';
import { ForbiddenError } from '../../platform/errors';
import {
  approveBankAccount,
  listBankAccounts,
  proposeBankAccount,
  rejectBankAccount,
} from './index';

const TODAY = '2026-10-07';
const NUMBER_1 = '50100012345678';
const NUMBER_2 = '00420000987654';
let env: TestEnv;
let fx: Fixture;
const cmd = () => env.services.commands;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
});
afterAll(async () => env.destroy());

const propose = (
  accountNumber: string,
  opts: { actor?: AuthenticatedActor; partyId?: string; key?: string } = {},
): Promise<BankAccountDto> =>
  cmd().execute(
    proposeBankAccount,
    {
      partyId: opts.partyId ?? fx.suppliers.local.id,
      accountHolderName: 'Local Steel Traders',
      accountNumber,
      ifsc: 'hdfc0001234',
      bankName: 'HDFC Bank',
      changeReason: "Supplier's letter dated 1 Oct",
    } satisfies ProposeBankAccountRequest,
    opts.actor ?? fx.actors.accountant,
    opts.key ? { idempotencyKey: opts.key } : {},
  );
const approve = (b: BankAccountDto, actor: AuthenticatedActor = fx.actors.owner) =>
  cmd().execute(approveBankAccount, { bankAccountId: b.id, expectedVersion: b.version }, actor);
const list = (actor: AuthenticatedActor = fx.actors.accountant) =>
  env.services.queries.execute(listBankAccounts, { partyId: fx.suppliers.local.id }, actor);

describe('supplier bank details (RESTRICTED, maker-checker)', () => {
  it('proposed by one person, approved by another; a change supersedes, never edits', async () => {
    const first = await propose(NUMBER_1, { key: 'bank-propose-1' });
    expect(first).toMatchObject({
      status: 'PENDING_APPROVAL',
      accountNumberMasked: 'XXXXXXXXXX5678',
      ifsc: 'HDFC0001234',
    });
    expect(first).not.toHaveProperty('accountNumber');
    await expect(propose(NUMBER_2)).rejects.toMatchObject({ rule: 'BANK_DETAILS_PENDING' });

    await expect(approve(first, fx.actors.accountant)).rejects.toBeInstanceOf(ForbiddenError);
    const active = await approve(first);
    expect(active).toMatchObject({
      status: 'ACTIVE',
      approvedByName: fx.actors.owner.user.displayName,
    });

    const change = await propose(NUMBER_2, { actor: fx.actors.owner });
    await expect(approve(change, fx.actors.owner)).rejects.toMatchObject({ rule: 'SELF_APPROVAL' });
    await approve(change, fx.actors.admin);

    const all = await list();
    expect(all.map((b) => [b.status, b.accountNumber])).toEqual([
      ['ACTIVE', NUMBER_2],
      ['SUPERSEDED', NUMBER_1],
    ]);
  });

  it('a rejected proposal changes nothing', async () => {
    const before = await list();
    const wrong = await propose('11112222333344');
    const rejected = await cmd().execute(
      rejectBankAccount,
      { bankAccountId: wrong.id, expectedVersion: wrong.version, reason: 'Not on letterhead' },
      fx.actors.owner,
    );
    expect(rejected.status).toBe('REJECTED');
    await expect(approve(rejected)).rejects.toMatchObject({ rule: 'BANK_DETAILS_NOT_PENDING' });
    const after = await list();
    expect(after.find((b) => b.status === 'ACTIVE')?.id).toBe(
      before.find((b) => b.status === 'ACTIVE')?.id,
    );
  });

  it('only suppliers have bank details', async () => {
    await expect(propose(NUMBER_1, { partyId: fx.customers.intra.id })).rejects.toMatchObject({
      rule: 'NOT_A_SUPPLIER',
    });
  });

  it('the full number never reaches the audit trail or stored idempotent replies', async () => {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from (
        select after::text as t from audit.events where entity_type = 'party.bank_account'
        union all select before::text from audit.events where entity_type = 'party.bank_account'
        union all select response::text from system.idempotency_keys
        union all select request_hash from system.idempotency_keys
      ) x where t like ${`%${NUMBER_1}%`} or t like ${`%${NUMBER_2}%`}`.execute(env.ownerDb);
    expect(rows[0]?.n).toBe(0);
  });

  it('logs redact account numbers', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = pino(loggerOptions('info', false), sink);
    log.info({ body: { accountNumber: NUMBER_1 }, accountNumber: NUMBER_2 }, 'request');
    expect(lines.join('')).not.toContain(NUMBER_1);
    expect(lines.join('')).not.toContain(NUMBER_2);
  });

  it('read needs party.bank.read; the AI can neither read nor change bank details', async () => {
    await expect(list(fx.actors.purchase)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(list(asAiAgent(fx.actors.owner))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(propose(NUMBER_1, { actor: asAiAgent(fx.actors.owner) })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(propose(NUMBER_1, { actor: fx.actors.purchase })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('SQL refuses edits, deletes and self-approval', async () => {
    const db = env.services.db;
    const [active] = await list();
    await expect(
      sql`update party.bank_accounts set account_number = '999999999' where id = ${active!.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: 'FO002' });
    await expect(
      sql`delete from party.bank_accounts where id = ${active!.id}`.execute(db),
    ).rejects.toThrow();
    const pending = await propose('77778888999900');
    await expect(
      sql`update party.bank_accounts
             set status = 'ACTIVE', approved_at = now(), approved_by = requested_by
           where id = ${pending.id}`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

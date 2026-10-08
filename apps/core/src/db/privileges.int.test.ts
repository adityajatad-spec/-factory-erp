import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { recordReceipt } from '../modules/receivables/commands';
import type { Database } from './database';
import { APP_SCHEMAS, inspectRuntimeRole, RUNTIME_GROUP_ROLE } from './roles';

let env: TestEnv;
const runtime = (): Database => env.services.db;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.destroy());

const INSUFFICIENT_PRIVILEGE = '42501';
const denied = (q: RawBuilder<unknown>) =>
  expect(q.execute(runtime())).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

describe('the runtime role cannot undermine database invariants', () => {
  it('cannot disable, drop or create triggers', async () => {
    await denied(sql`alter table sales.invoices disable trigger invoices_guard_update`);
    await denied(sql`alter table finance.party_ledger_entries disable trigger all`);
    await denied(sql`drop trigger audit_events_append_only on audit.events`);
    await denied(sql`create trigger t before insert on sales.invoices
                     for each row execute function system.touch_updated_at()`);
  });

  it('cannot bypass triggers with session_replication_role', async () => {
    await denied(sql`set session_replication_role = replica`);
  });

  it('cannot alter, drop or create tables, schemas or functions', async () => {
    await denied(sql`alter table sales.invoices add column backdoor text`);
    await denied(sql`alter table sales.invoices drop constraint invoices_cancellation_check`);
    await denied(sql`drop table finance.receipts`);
    await denied(sql`create table sales.shadow (id int)`);
    await denied(sql`create schema shadow`);
    await denied(sql`create function sales.f() returns int language sql as 'select 1'`);
    await denied(sql`create or replace function system.forbid_mutation() returns trigger
                     language plpgsql as 'begin return new; end'`);
  });

  it('cannot create extensions (trusted or untrusted)', async () => {
    await denied(sql`create extension if not exists pgcrypto`);
    await denied(sql`create extension if not exists dblink`);
  });

  it('cannot truncate, update or delete append-only tables', async () => {
    await denied(sql`truncate audit.events`);
    await denied(sql`truncate docs.documents`);
    await denied(sql`update audit.events set command = 'tampered'`);
    await denied(sql`delete from finance.party_ledger_entries`);
    await denied(sql`update finance.receipts set amount = 1`);
    await denied(sql`delete from finance.receipt_allocations`);
    await denied(sql`update docs.documents set sha256 = 'x'`);
    await denied(sql`delete from inventory.stock_movements`);
  });

  it('cannot rewrite migration history or escalate its own role', async () => {
    await denied(sql`delete from system.schema_migrations`);
    await denied(
      sql`insert into system.schema_migrations (version, name, checksum) values ('9999', 'x', 'x')`,
    );
    await denied(sql`alter role current_user superuser`);
    await denied(sql`create role intruder`);
    await denied(sql.raw(`grant ${RUNTIME_GROUP_ROLE} to current_user with admin option`));
    const owner = (await sql<{ u: string }>`select current_user as u`.execute(env.ownerDb)).rows[0]
      ?.u;
    await expect(sql.raw(`set role "${owner}"`).execute(runtime())).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('can still do its job: read and write ordinary rows', async () => {
    const r = await sql<{ n: string }>`select count(*) as n from identity.users`.execute(runtime());
    expect(r.rows).toHaveLength(1);
    await sql`insert into platform.states (code, name) values ('99', 'Test State')`.execute(
      runtime(),
    );
    await sql`update platform.states set name = 'Renamed' where code = '99'`.execute(runtime());
    await sql`delete from platform.states where code = '99'`.execute(runtime());
  });

  it('the startup check passes for the runtime role and flags the owner', async () => {
    expect(await inspectRuntimeRole(runtime())).toMatchObject({ problems: [] });
    const owner = await inspectRuntimeRole(env.ownerDb);
    expect(owner.problems.join('; ')).toMatch(/superuser|owns/);
  });
});

/**
 * Catalogue checks: they fail when a later migration adds a table, view or function without
 * the matching privilege decision, so the role model cannot silently drift.
 */
describe('privilege drift guards', () => {
  const schemas = [...APP_SCHEMAS];

  it('append-only tables (forbid_mutation triggers) grant the runtime no UPDATE, DELETE or TRUNCATE', async () => {
    const { rows } = await sql<{ rel: string; update: boolean; del: boolean; truncate: boolean }>`
      select distinct c.oid::regclass::text as rel,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'UPDATE') as update,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'DELETE') as del,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'TRUNCATE') as truncate
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where p.proname = 'forbid_mutation' and not t.tgisinternal
      order by 1`.execute(env.ownerDb);
    expect(rows.map((r) => r.rel)).toEqual(
      expect.arrayContaining(['audit.events', 'docs.documents', 'finance.party_ledger_entries']),
    );
    expect(rows.filter((r) => r.update || r.del || r.truncate).map((r) => r.rel)).toEqual([]);
  });

  it('the only column-level UPDATE on an append-only table is the lock-only receipt id', async () => {
    const { rows } = await sql<{ col: string }>`
      select distinct c.oid::regclass::text || '.' || a.attname as col
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where p.proname = 'forbid_mutation' and not t.tgisinternal
        and has_column_privilege(${RUNTIME_GROUP_ROLE}, c.oid, a.attnum, 'UPDATE')
      order by 1`.execute(env.ownerDb);
    expect(rows.map((r) => r.col)).toEqual(['finance.receipts.id']);
    // It exists only so allocation can lock the row; an actual update is still refused.
    const fx = await createFixture(env.services);
    await env.services.commands.execute(
      recordReceipt,
      {
        customerId: fx.customers.intra.id,
        receiptDate: '2026-10-05',
        amount: '10.00',
        paymentMode: 'UPI',
      },
      fx.actors.accountant,
    );
    await expect(sql`update finance.receipts set id = id`.execute(runtime())).rejects.toMatchObject(
      {
        code: 'FO001',
      },
    );
  });

  it('every append-only table also refuses TRUNCATE by trigger (binds the owner too)', async () => {
    const { rows } = await sql<{ rel: string }>`
      select distinct c.oid::regclass::text as rel
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where p.proname = 'forbid_mutation' and not t.tgisinternal
        and not exists (
          select 1 from pg_trigger t2 join pg_proc p2 on p2.oid = t2.tgfoid
          where t2.tgrelid = c.oid and p2.proname = 'forbid_mutation'
            and (t2.tgtype & 32) <> 0  -- TRUNCATE
        )`.execute(env.ownerDb);
    expect(rows.map((r) => r.rel)).toEqual([]);
  });

  it('every application table is usable by the runtime and every view is read-only', async () => {
    const { rows } = await sql<{
      rel: string;
      kind: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
    }>`
      select c.oid::regclass::text as rel, c.relkind::text as kind,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'SELECT') as sel,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'INSERT') as ins,
             has_table_privilege(${RUNTIME_GROUP_ROLE}, c.oid, 'UPDATE') as upd
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas}::text[]) and c.relkind in ('r', 'p', 'v', 'm')
      order by 1`.execute(env.ownerDb);
    expect(rows.filter((r) => !r.sel).map((r) => r.rel)).toEqual([]);
    expect(rows.filter((r) => r.kind !== 'r' && (r.ins || r.upd)).map((r) => r.rel)).toEqual([]);
  });

  it('the runtime can create nothing: no schema CREATE, no database CREATE', async () => {
    const { rows } = await sql<{ nspname: string }>`
      select nspname from pg_namespace
      where has_schema_privilege(${RUNTIME_GROUP_ROLE}, oid, 'CREATE')`.execute(env.ownerDb);
    expect(rows).toEqual([]);
    const db = await sql<{ c: boolean }>`
      select has_database_privilege(${RUNTIME_GROUP_ROLE}, current_database(), 'CREATE') as c`.execute(
      env.ownerDb,
    );
    expect(db.rows[0]?.c).toBe(false);
  });

  it('every function in the application schemas pins its search_path', async () => {
    const { rows } = await sql<{ fn: string }>`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${schemas}::text[])
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
      order by 1`.execute(env.ownerDb);
    expect(rows.map((r) => r.fn)).toEqual([]);
  });
});

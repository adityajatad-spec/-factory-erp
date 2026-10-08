-- Least-privilege runtime role (Slice 0).
--
-- Migrations run as the schema OWNER. The application server connects as a LOGIN role that is
-- a member of factoryerp_runtime. That role can read and write rows, but it cannot change the
-- schema: no DDL, no TRUNCATE, no triggers and no ownership. It therefore cannot disable the
-- immutability triggers, and it cannot UPDATE or DELETE rows of append-only tables at all.
-- The triggers remain as a second line of defence, which also binds the owner.
--
-- Login roles are created per environment by `pnpm db:migrate` (see src/db/roles.ts), never
-- here: passwords do not belong in migrations.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'factoryerp_runtime') then
    create role factoryerp_runtime nologin;
  end if;
end
$$;

-- Schemas: USAGE only. Without CREATE the runtime cannot add tables, functions or triggers.
grant usage on schema platform, identity, audit, system, party, catalog, sales, finance, docs, inventory
  to factoryerp_runtime;

-- Tables: read and write rows. Views: read only (a simple view could otherwise be written
-- through with the owner's privileges).
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('platform', 'identity', 'audit', 'system', 'party', 'catalog', 'sales',
                        'finance', 'docs', 'inventory')
      and c.relkind in ('r', 'p', 'v', 'm')
  loop
    if r.relkind in ('r', 'p') then
      execute format('grant select, insert, update, delete on %s to factoryerp_runtime', r.rel);
    else
      execute format('grant select on %s to factoryerp_runtime', r.rel);
    end if;
  end loop;
end
$$;

-- Append-only tables: insert and read only.
revoke update, delete on
  audit.events,
  docs.documents,
  finance.party_ledger_entries,
  finance.receipts,
  finance.receipt_allocations,
  inventory.stock_movements
from factoryerp_runtime;

-- Exception: row locks (SELECT … FOR UPDATE) need UPDATE privilege on at least one column.
-- Allocation locks the receipt row to serialise concurrent allocations, so the runtime may
-- "update" finance.receipts.id — which grants the lock only: any actual UPDATE is still
-- refused by the append-only trigger.
grant update (id) on finance.receipts to factoryerp_runtime;

-- Migration history: read only. The server checks at startup that the schema is current.
revoke insert, update, delete on system.schema_migrations from factoryerp_runtime;

-- Tables created by later migrations (run by this same owner) get row privileges automatically.
-- A later migration that adds an append-only table or a view must revoke what it should not
-- have; src/db/privileges.int.test.ts fails until it does.
alter default privileges in schema platform, identity, audit, system, party, catalog, sales,
  finance, docs, inventory
  grant select, insert, update, delete on tables to factoryerp_runtime;
alter default privileges in schema platform, identity, audit, system, party, catalog, sales,
  finance, docs, inventory
  grant usage, select on sequences to factoryerp_runtime;

-- docs.documents was the one append-only table without a TRUNCATE guard.
create trigger documents_no_truncate before truncate on docs.documents
  for each statement execute function system.forbid_mutation();

-- Pin search_path on every trigger function, so no session state (for example a temporary
-- table with the same name as a schema table) can change what a guard reads.
alter function system.forbid_mutation() set search_path = pg_catalog, pg_temp;
alter function system.touch_updated_at() set search_path = pg_catalog, pg_temp;
alter function sales.guard_invoice_update() set search_path = pg_catalog, pg_temp;
alter function sales.guard_invoice_delete() set search_path = pg_catalog, pg_temp;
alter function sales.guard_invoice_lines() set search_path = pg_catalog, pg_temp;
alter function sales.guard_credit_note_update() set search_path = pg_catalog, pg_temp;
alter function sales.guard_credit_note_delete() set search_path = pg_catalog, pg_temp;
alter function sales.guard_credit_note_lines() set search_path = pg_catalog, pg_temp;
alter function sales.check_credit_note() set search_path = pg_catalog, pg_temp;
alter function finance.check_allocation() set search_path = pg_catalog, pg_temp;

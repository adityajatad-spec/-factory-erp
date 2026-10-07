-- Minimal inventory: warehouses and an append-only stock ledger. Balances are derived.
-- Whether sales invoices or dispatches move stock is NOT decided yet (factory discovery
-- deferred), so the sales slice does not post stock movements.

create schema inventory;

create table inventory.warehouses (
  id         uuid primary key,
  company_id uuid not null references platform.companies (id),
  code       text not null check (code ~ '^[A-Z0-9-]{2,20}$'),
  name       text not null,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table inventory.stock_movements (
  id            uuid primary key,
  company_id    uuid not null references platform.companies (id),
  item_id       uuid not null references catalog.items (id),
  warehouse_id  uuid not null references inventory.warehouses (id),
  movement_date date not null,
  movement_type text not null check (movement_type in ('OPENING', 'RECEIPT', 'ISSUE', 'ADJUSTMENT')),
  -- Signed quantity in the item's unit: positive in, negative out.
  quantity      numeric(18, 3) not null check (quantity <> 0),
  source_type   text,
  source_id     uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid references identity.users (id)
);

create index stock_movements_item_idx on inventory.stock_movements (company_id, item_id, warehouse_id);

create trigger stock_movements_append_only before update or delete on inventory.stock_movements
  for each row execute function system.forbid_mutation();
create trigger stock_movements_no_truncate before truncate on inventory.stock_movements
  for each statement execute function system.forbid_mutation();

create view inventory.stock_on_hand as
  select company_id, item_id, warehouse_id, sum(quantity) as quantity
    from inventory.stock_movements
   group by company_id, item_id, warehouse_id;

-- Parties (customers & suppliers in one table) and the item catalogue with
-- effective-dated GST rates.

create schema party;
create schema catalog;

create table party.parties (
  id            uuid primary key,
  company_id    uuid not null references platform.companies (id),
  code          text not null check (code ~ '^[A-Z0-9-]{2,20}$'),
  name          text not null check (length(name) between 2 and 200),
  is_customer   boolean not null default false,
  is_supplier   boolean not null default false,
  gstin         text check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code    char(2) not null references platform.states (code),
  address_line1 text,
  address_line2 text,
  city          text,
  postal_code   text,
  contact_name  text,
  phone         text,
  email         text,
  credit_days   integer check (credit_days between 0 and 365),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  version       integer not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  created_by    uuid references identity.users (id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references identity.users (id),
  unique (company_id, code),
  check (is_customer or is_supplier),
  check (gstin is null or substr(gstin, 1, 2) = state_code)
);

create unique index parties_gstin_uidx on party.parties (company_id, gstin) where gstin is not null;
create index parties_name_trgm_idx on party.parties using gin (name gin_trgm_ops);

create trigger parties_touch before update on party.parties
  for each row execute function system.touch_updated_at();

-- Units of measure. Codes follow GST UQC style; the list must be verified [VERIFY R-14].
create table catalog.uoms (
  code text primary key check (code ~ '^[A-Z]{2,10}$'),
  name text not null
);

insert into catalog.uoms (code, name) values
  ('NOS', 'Numbers'), ('PCS', 'Pieces'), ('KGS', 'Kilograms'), ('MTR', 'Metres'),
  ('LTR', 'Litres'), ('SET', 'Sets'), ('BOX', 'Boxes'), ('MTS', 'Metric tonnes');

create table catalog.hsn_codes (
  code        text primary key check (code ~ '^[0-9]{4,8}$'),
  description text not null
);

-- Effective-dated GST rate per HSN code. Rates are regulatory data [VERIFY R-01]: every row
-- records where it came from and how far it has been verified. Ranges may not overlap.
create table catalog.gst_rates (
  id                  uuid primary key,
  hsn_code            text not null references catalog.hsn_codes (code),
  rate_percent        numeric(6, 3) not null check (rate_percent between 0 and 100),
  effective_from      date not null,
  effective_to        date,
  source_note         text not null,
  verification_status text not null check (verification_status in ('DEMO_UNVERIFIED', 'SOURCE_FOUND', 'CA_CONFIRMED')),
  created_at          timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (
    hsn_code with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
);

create table catalog.items (
  id                 uuid primary key,
  company_id         uuid not null references platform.companies (id),
  code               text not null check (code ~ '^[A-Z0-9-]{2,30}$'),
  name               text not null check (length(name) between 2 and 200),
  description        text,
  item_type          text not null
    check (item_type in ('RAW_MATERIAL', 'COMPONENT', 'FINISHED_GOOD', 'CONSUMABLE', 'SPARE', 'SERVICE')),
  uom                text not null references catalog.uoms (code),
  hsn_code           text not null references catalog.hsn_codes (code),
  default_sale_rate  numeric(18, 4) check (default_sale_rate >= 0),
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  version            integer not null default 1 check (version >= 1),
  created_at         timestamptz not null default now(),
  created_by         uuid references identity.users (id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references identity.users (id),
  unique (company_id, code)
);

create index items_name_trgm_idx on catalog.items using gin (name gin_trgm_ops);

create trigger items_touch before update on catalog.items
  for each row execute function system.touch_updated_at();

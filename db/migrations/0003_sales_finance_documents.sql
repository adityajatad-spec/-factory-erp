-- Sales invoices, customer/supplier balances (R2-D4: immutable vouchers + party ledger,
-- no general ledger yet), and generated documents.

create schema sales;
create schema finance;
create schema docs;

create table docs.documents (
  id          uuid primary key,
  company_id  uuid not null references platform.companies (id),
  kind        text not null check (kind in ('SALES_INVOICE_PDF', 'UPLOAD')),
  filename    text not null,
  mime_type   text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references identity.users (id)
);

-- Documents are evidence: never edited, never deleted by the application.
create trigger documents_append_only before update or delete on docs.documents
  for each row execute function system.forbid_mutation();

create table sales.invoices (
  id                          uuid primary key,
  company_id                  uuid not null references platform.companies (id),
  status                      text not null default 'DRAFT' check (status in ('DRAFT', 'ISSUED', 'CANCELLED')),
  invoice_number              text,
  fiscal_year                 text,
  invoice_date                date not null,
  customer_id                 uuid not null references party.parties (id),
  supplier_state_code         char(2) not null references platform.states (code),
  place_of_supply_state_code  char(2) not null references platform.states (code),
  supply_type                 text not null check (supply_type in ('INTRA_STATE', 'INTER_STATE')),
  notes                       text,
  -- Totals are always computed by the server-side GST engine (never accepted from clients).
  gross_amount                numeric(18, 2) not null,
  discount_amount             numeric(18, 2) not null,
  taxable_amount              numeric(18, 2) not null,
  cgst_amount                 numeric(18, 2) not null,
  sgst_amount                 numeric(18, 2) not null,
  igst_amount                 numeric(18, 2) not null,
  total_tax                   numeric(18, 2) not null,
  round_off                   numeric(18, 2) not null,
  grand_total                 numeric(18, 2) not null check (grand_total >= 0),
  amount_in_words             text not null,
  calc_engine_version         text not null,
  gst_policy                  jsonb not null,
  -- Snapshots of everything printed on the invoice, frozen at issue time.
  seller_snapshot             jsonb,
  customer_snapshot           jsonb,
  pdf_document_id             uuid references docs.documents (id),
  issued_at                   timestamptz,
  issued_by                   uuid references identity.users (id),
  version                     integer not null default 1 check (version >= 1),
  created_at                  timestamptz not null default now(),
  created_by                  uuid references identity.users (id),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references identity.users (id),
  unique (company_id, invoice_number),
  check ((status = 'DRAFT') = (invoice_number is null)),
  check (
    status = 'DRAFT'
    or (fiscal_year is not null and issued_at is not null and issued_by is not null
        and seller_snapshot is not null and customer_snapshot is not null)
  ),
  check (cgst_amount = sgst_amount),
  check (supply_type = 'INTRA_STATE' or (cgst_amount = 0 and sgst_amount = 0)),
  check (supply_type = 'INTER_STATE' or igst_amount = 0)
);

create index invoices_company_status_idx on sales.invoices (company_id, status, invoice_date desc);
create index invoices_customer_idx on sales.invoices (customer_id);

create table sales.invoice_lines (
  invoice_id         uuid not null references sales.invoices (id) on delete cascade,
  line_no            integer not null check (line_no >= 1),
  item_id            uuid not null references catalog.items (id),
  description        text not null,
  hsn_code           text not null,
  uom                text not null,
  quantity           numeric(18, 3) not null check (quantity > 0),
  unit_rate          numeric(18, 4) not null check (unit_rate >= 0),
  discount_percent   numeric(6, 3) not null check (discount_percent between 0 and 100),
  gst_rate_percent   numeric(6, 3) not null check (gst_rate_percent between 0 and 100),
  gross_amount       numeric(18, 2) not null,
  discount_amount    numeric(18, 2) not null,
  taxable_amount     numeric(18, 2) not null,
  cgst_rate_percent  numeric(6, 3) not null,
  cgst_amount        numeric(18, 2) not null,
  sgst_rate_percent  numeric(6, 3) not null,
  sgst_amount        numeric(18, 2) not null,
  igst_rate_percent  numeric(6, 3) not null,
  igst_amount        numeric(18, 2) not null,
  line_total         numeric(18, 2) not null,
  primary key (invoice_id, line_no)
);

-- Issued invoices are immutable. After issue only these may change:
-- the PDF reference (once), the bookkeeping columns, and the status (ISSUED → CANCELLED).
create function sales.guard_invoice_update() returns trigger
language plpgsql as $$
declare
  mutable constant text[] := array['pdf_document_id', 'status', 'version', 'updated_at', 'updated_by'];
begin
  if old.status = 'DRAFT' then
    return new;
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Invoice % is %; its financial content is immutable', old.invoice_number, old.status
      using errcode = 'FO002';
  end if;
  if old.pdf_document_id is not null and new.pdf_document_id is distinct from old.pdf_document_id then
    raise exception 'Invoice % already has a PDF; it cannot be replaced', old.invoice_number
      using errcode = 'FO002';
  end if;
  if new.status <> old.status and not (old.status = 'ISSUED' and new.status = 'CANCELLED') then
    raise exception 'Invalid invoice status transition % → %', old.status, new.status
      using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger invoices_guard_update before update on sales.invoices
  for each row execute function sales.guard_invoice_update();

create function sales.guard_invoice_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'DRAFT' then
    raise exception 'Invoice % is %; only drafts can be deleted', old.invoice_number, old.status
      using errcode = 'FO002';
  end if;
  return old;
end;
$$;

create trigger invoices_guard_delete before delete on sales.invoices
  for each row execute function sales.guard_invoice_delete();

create trigger invoices_touch before update on sales.invoices
  for each row execute function system.touch_updated_at();

-- Lines may only change while the parent invoice is a draft.
create function sales.guard_invoice_lines() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  select status into parent_status from sales.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if parent_status is not null and parent_status <> 'DRAFT' then
    raise exception 'Lines of a % invoice are immutable', parent_status using errcode = 'FO002';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger invoice_lines_guard before insert or update or delete on sales.invoice_lines
  for each row execute function sales.guard_invoice_lines();

-- Customer/supplier balances: append-only party ledger (R2-D4). Debit increases what a
-- customer owes; credit reduces it. Corrections are new entries, never edits.
create table finance.party_ledger_entries (
  id          uuid primary key,
  company_id  uuid not null references platform.companies (id),
  party_id    uuid not null references party.parties (id),
  entry_date  date not null,
  entry_type  text not null check (entry_type in ('OPENING_BALANCE', 'SALES_INVOICE', 'RECEIPT', 'CREDIT_NOTE')),
  source_type text not null,
  source_id   uuid not null,
  debit       numeric(18, 2) not null default 0 check (debit >= 0),
  credit      numeric(18, 2) not null default 0 check (credit >= 0),
  narration   text,
  created_at  timestamptz not null default now(),
  created_by  uuid references identity.users (id),
  check ((debit = 0) <> (credit = 0)),
  unique (source_type, source_id, entry_type)
);

create index party_ledger_party_idx on finance.party_ledger_entries (company_id, party_id, entry_date);

create trigger party_ledger_append_only before update or delete on finance.party_ledger_entries
  for each row execute function system.forbid_mutation();
create trigger party_ledger_no_truncate before truncate on finance.party_ledger_entries
  for each statement execute function system.forbid_mutation();

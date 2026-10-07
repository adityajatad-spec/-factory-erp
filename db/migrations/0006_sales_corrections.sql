-- Sales correction path: invoice cancellation and credit notes (docs/adr/0002).
--
-- Principles are unchanged: issued documents are immutable, ledgers are append-only and
-- balances are derived. A correction is a NEW record — a cancellation entry or a credit
-- note — never an edit of history. The application checks every rule first, under row
-- locks; the database re-checks them here as the last line of defence.
--
-- Settlement invariant for every ISSUED invoice:
--   Σ receipt allocations + Σ issued credit notes ≤ grand total
-- so the derived outstanding (grand total − paid − credited) can never be negative.

-- ─── 1. Invoice cancellation ─────────────────────────────────────────────────────────────

alter table sales.invoices
  add column cancelled_at        timestamptz,
  add column cancelled_by        uuid references identity.users (id),
  add column cancellation_reason text,
  add constraint invoices_cancellation_check check (
    ((status = 'CANCELLED') = (cancelled_at is not null))
    and ((cancelled_at is null) = (cancelled_by is null))
    and ((cancelled_at is null) = (cancellation_reason is null))
    and (cancellation_reason is null or char_length(btrim(cancellation_reason)) between 3 and 500)
  ),
  -- Lets credit notes reference (invoice, customer, company) as one declarative foreign key.
  add constraint invoices_id_customer_company_key unique (id, customer_id, company_id);

-- Cancelling posts a reversing credit to the customer's balance (append-only ledger).
alter table finance.party_ledger_entries drop constraint party_ledger_entries_entry_type_check;
alter table finance.party_ledger_entries
  add constraint party_ledger_entries_entry_type_check check (
    entry_type in ('OPENING_BALANCE', 'SALES_INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'INVOICE_CANCELLATION')
  );

alter table docs.documents drop constraint documents_kind_check;
alter table docs.documents
  add constraint documents_kind_check check (
    kind in ('SALES_INVOICE_PDF', 'SALES_CREDIT_NOTE_PDF', 'UPLOAD')
  );

-- ─── 2. Credit notes ─────────────────────────────────────────────────────────────────────

alter table platform.companies
  add column credit_note_prefix text not null default 'CN'
    check (credit_note_prefix ~ '^[A-Z0-9-]{1,6}$');

-- A credit note always credits ONE issued invoice of the same customer and company. Its tax
-- position (supplier state, place of supply, rates, rounding policy) is inherited from that
-- invoice, never chosen independently.
create table sales.credit_notes (
  id                          uuid primary key,
  company_id                  uuid not null references platform.companies (id),
  status                      text not null default 'DRAFT' check (status in ('DRAFT', 'ISSUED')),
  credit_note_number          text,
  fiscal_year                 text check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  credit_note_date            date not null,
  invoice_id                  uuid not null,
  customer_id                 uuid not null,
  -- [VERIFY R-03] Grounds on which a GST credit note may be issued, and its time limit.
  reason_code                 text not null check (
    reason_code in ('SALES_RETURN', 'POST_SALE_DISCOUNT', 'PRICE_CORRECTION', 'DEFICIENT_SUPPLY', 'OTHER')
  ),
  reason                      text not null check (char_length(btrim(reason)) between 3 and 500),
  notes                       text,
  supplier_state_code         char(2) not null references platform.states (code),
  place_of_supply_state_code  char(2) not null references platform.states (code),
  supply_type                 text not null check (supply_type in ('INTRA_STATE', 'INTER_STATE')),
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
  foreign key (invoice_id, customer_id, company_id)
    references sales.invoices (id, customer_id, company_id),
  unique (company_id, credit_note_number),
  unique (id, invoice_id),
  check ((status = 'DRAFT') = (credit_note_number is null)),
  check (
    status = 'DRAFT'
    or (fiscal_year is not null and issued_at is not null and issued_by is not null
        and seller_snapshot is not null and customer_snapshot is not null and grand_total > 0)
  ),
  check (cgst_amount = sgst_amount),
  check (supply_type = 'INTRA_STATE' or (cgst_amount = 0 and sgst_amount = 0)),
  check (supply_type = 'INTER_STATE' or igst_amount = 0)
);

create index credit_notes_company_status_idx on sales.credit_notes (company_id, status, credit_note_date desc);
create index credit_notes_invoice_idx on sales.credit_notes (invoice_id, status);

-- Each line credits one line of the original invoice (quantity × rate, with that line's
-- discount and GST rate). Lines can only point at lines of the credit note's own invoice.
create table sales.credit_note_lines (
  credit_note_id     uuid not null,
  invoice_id         uuid not null,
  line_no            integer not null check (line_no >= 1),
  invoice_line_no    integer not null,
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
  primary key (credit_note_id, line_no),
  unique (credit_note_id, invoice_line_no),
  foreign key (credit_note_id, invoice_id)
    references sales.credit_notes (id, invoice_id) on delete cascade,
  foreign key (invoice_id, invoice_line_no) references sales.invoice_lines (invoice_id, line_no)
);

-- Issued credit notes are immutable. Afterwards only the PDF reference (once) and the
-- bookkeeping columns may change. A draft's invoice can never change.
create function sales.guard_credit_note_update() returns trigger
language plpgsql as $$
declare
  mutable constant text[] := array['pdf_document_id', 'version', 'updated_at', 'updated_by'];
begin
  if (new.invoice_id, new.customer_id, new.company_id)
       is distinct from (old.invoice_id, old.customer_id, old.company_id) then
    raise exception 'The invoice a credit note credits cannot be changed' using errcode = 'FO002';
  end if;
  if old.status = 'DRAFT' then
    return new;
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Credit note % is %; its content is immutable', old.credit_note_number, old.status
      using errcode = 'FO002';
  end if;
  if old.pdf_document_id is not null and new.pdf_document_id is distinct from old.pdf_document_id then
    raise exception 'Credit note % already has a PDF; it cannot be replaced', old.credit_note_number
      using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger credit_notes_guard_update before update on sales.credit_notes
  for each row execute function sales.guard_credit_note_update();

create function sales.guard_credit_note_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'DRAFT' then
    raise exception 'Credit note % is %; only drafts can be deleted', old.credit_note_number, old.status
      using errcode = 'FO002';
  end if;
  return old;
end;
$$;

create trigger credit_notes_guard_delete before delete on sales.credit_notes
  for each row execute function sales.guard_credit_note_delete();

create trigger credit_notes_touch before update on sales.credit_notes
  for each row execute function system.touch_updated_at();

create function sales.guard_credit_note_lines() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  select status into parent_status from sales.credit_notes
   where id = coalesce(new.credit_note_id, old.credit_note_id);
  if parent_status is not null and parent_status <> 'DRAFT' then
    raise exception 'Lines of a % credit note are immutable', parent_status using errcode = 'FO002';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger credit_note_lines_guard before insert or update or delete on sales.credit_note_lines
  for each row execute function sales.guard_credit_note_lines();

-- Defence in depth: at COMMIT (deferred), every issued credit note must credit an issued
-- invoice, within that invoice's lines (quantity, rate and taxable value per line) and within
-- its settlement invariant. SQLSTATE FO004.
create function sales.check_credit_note() returns trigger
language plpgsql as $$
declare
  inv      record;
  paid     numeric;
  credited numeric;
  bad      record;
begin
  if new.status <> 'ISSUED' then
    return null;
  end if;

  select status, invoice_number, invoice_date, grand_total into inv
    from sales.invoices where id = new.invoice_id;
  if inv.status <> 'ISSUED' then
    raise exception 'Credit note % credits invoice % which is %', new.credit_note_number, inv.invoice_number, inv.status
      using errcode = 'FO004';
  end if;
  if new.credit_note_date < inv.invoice_date then
    raise exception 'Credit note % is dated before invoice %', new.credit_note_number, inv.invoice_number
      using errcode = 'FO004';
  end if;
  if not exists (select 1 from sales.credit_note_lines where credit_note_id = new.id) then
    raise exception 'Credit note % has no lines', new.credit_note_number using errcode = 'FO004';
  end if;

  select cl.line_no into bad
    from sales.credit_note_lines cl
    join sales.invoice_lines l on l.invoice_id = cl.invoice_id and l.line_no = cl.invoice_line_no
   where cl.credit_note_id = new.id
     and (cl.quantity > l.quantity or cl.unit_rate > l.unit_rate
          or cl.discount_percent <> l.discount_percent or cl.gst_rate_percent <> l.gst_rate_percent)
   limit 1;
  if found then
    raise exception 'Line % of credit note % does not match the invoice line it credits', bad.line_no, new.credit_note_number
      using errcode = 'FO004';
  end if;

  select coalesce(sum(amount), 0) into paid
    from finance.receipt_allocations where invoice_id = new.invoice_id;
  select coalesce(sum(grand_total), 0) into credited
    from sales.credit_notes where invoice_id = new.invoice_id and status = 'ISSUED';
  if paid + credited > inv.grand_total then
    raise exception 'Invoice % over-settled: % paid + % credited exceeds its total of %',
      inv.invoice_number, paid, credited, inv.grand_total using errcode = 'FO004';
  end if;

  select l.line_no, l.taxable_amount, sum(cl.taxable_amount) as credited into bad
    from sales.invoice_lines l
    join sales.credit_note_lines cl on cl.invoice_id = l.invoice_id and cl.invoice_line_no = l.line_no
    join sales.credit_notes cn on cn.id = cl.credit_note_id and cn.status = 'ISSUED'
   where l.invoice_id = new.invoice_id
   group by l.line_no, l.taxable_amount
  having sum(cl.taxable_amount) > l.taxable_amount
   limit 1;
  if found then
    raise exception 'Line % of invoice % over-credited: % credited of % taxable',
      bad.line_no, inv.invoice_number, bad.credited, bad.taxable_amount using errcode = 'FO004';
  end if;
  return null;
end;
$$;

create constraint trigger credit_notes_settlement_check
  after insert or update on sales.credit_notes
  deferrable initially deferred
  for each row execute function sales.check_credit_note();

-- ─── 3. Existing rules, now aware of credit notes ────────────────────────────────────────

-- Issued invoices stay immutable. New: ISSUED → CANCELLED writes the cancellation details
-- exactly once, and only when nothing has settled the invoice (no payments allocated, no
-- issued credit notes) — refunds and un-allocation are not modelled yet. Drafts can be
-- issued or deleted, never cancelled.
create or replace function sales.guard_invoice_update() returns trigger
language plpgsql as $$
declare
  mutable constant text[] := array[
    'pdf_document_id', 'status', 'version', 'updated_at', 'updated_by',
    'cancelled_at', 'cancelled_by', 'cancellation_reason'
  ];
  cancelling constant boolean := old.status = 'ISSUED' and new.status = 'CANCELLED';
begin
  if old.status = 'DRAFT' then
    if new.status not in ('DRAFT', 'ISSUED') then
      raise exception 'Invalid invoice status transition % → %', old.status, new.status
        using errcode = 'FO002';
    end if;
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
  if new.status <> old.status and not cancelling then
    raise exception 'Invalid invoice status transition % → %', old.status, new.status
      using errcode = 'FO002';
  end if;
  if not cancelling
     and (new.cancelled_at, new.cancelled_by, new.cancellation_reason)
         is distinct from (old.cancelled_at, old.cancelled_by, old.cancellation_reason) then
    raise exception 'Cancellation details of invoice % cannot be changed', old.invoice_number
      using errcode = 'FO002';
  end if;
  if cancelling then
    if exists (select 1 from finance.receipt_allocations where invoice_id = old.id) then
      raise exception 'Invoice % has payments allocated; it cannot be cancelled', old.invoice_number
        using errcode = 'FO002';
    end if;
    if exists (select 1 from sales.credit_notes where invoice_id = old.id and status = 'ISSUED') then
      raise exception 'Invoice % has issued credit notes; it cannot be cancelled', old.invoice_number
        using errcode = 'FO002';
    end if;
  end if;
  return new;
end;
$$;

-- Allocations: Σ allocations + Σ issued credit notes ≤ grand total (was: allocations only).
create or replace function finance.check_allocation() returns trigger
language plpgsql as $$
declare
  r_company  uuid;
  r_customer uuid;
  r_amount   numeric;
  r_alloc    numeric;
  i_company  uuid;
  i_customer uuid;
  i_status   text;
  i_total    numeric;
  i_alloc    numeric;
  i_credit   numeric;
begin
  select company_id, customer_id, amount into r_company, r_customer, r_amount
    from finance.receipts where id = new.receipt_id;
  select company_id, customer_id, status, grand_total into i_company, i_customer, i_status, i_total
    from sales.invoices where id = new.invoice_id;

  if new.company_id <> r_company or new.company_id <> i_company then
    raise exception 'Allocation crosses companies' using errcode = 'FO003';
  end if;
  if r_customer <> i_customer then
    raise exception 'Receipt and invoice belong to different customers' using errcode = 'FO003';
  end if;
  if i_status <> 'ISSUED' then
    raise exception 'Payments can only be allocated to issued invoices (invoice is %)', i_status using errcode = 'FO003';
  end if;

  select coalesce(sum(amount), 0) into r_alloc from finance.receipt_allocations where receipt_id = new.receipt_id;
  if r_alloc > r_amount then
    raise exception 'Receipt over-allocated: % allocated of %', r_alloc, r_amount using errcode = 'FO003';
  end if;

  select coalesce(sum(amount), 0) into i_alloc from finance.receipt_allocations where invoice_id = new.invoice_id;
  select coalesce(sum(grand_total), 0) into i_credit
    from sales.credit_notes where invoice_id = new.invoice_id and status = 'ISSUED';
  if i_alloc + i_credit > i_total then
    raise exception 'Invoice over-settled: % allocated + % credited against a total of %', i_alloc, i_credit, i_total
      using errcode = 'FO003';
  end if;
  return null;
end;
$$;

-- Derived settlement position of every issued invoice, now net of credit notes.
-- (credited_amount is appended so existing columns keep their positions.)
create or replace view finance.invoice_balances as
  select i.id                                                        as invoice_id,
         i.company_id,
         i.customer_id,
         i.invoice_number,
         i.invoice_date,
         i.grand_total,
         p.paid::numeric(18, 2)                                      as paid_amount,
         (i.grand_total - p.paid - c.credited)::numeric(18, 2)       as outstanding_amount,
         c.credited::numeric(18, 2)                                  as credited_amount
    from sales.invoices i
    cross join lateral (
      select coalesce(sum(a.amount), 0) as paid
        from finance.receipt_allocations a where a.invoice_id = i.id
    ) p
    cross join lateral (
      select coalesce(sum(cn.grand_total), 0) as credited
        from sales.credit_notes cn where cn.invoice_id = i.id and cn.status = 'ISSUED'
    ) c
   where i.status = 'ISSUED';

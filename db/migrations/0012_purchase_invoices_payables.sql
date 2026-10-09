-- Purchase invoices, the supplier payable ledger and supplier payments (Slice 1).
--
-- Purchase invoice: DRAFT → POSTED (then immutable; corrections will be debit notes, not edits).
-- Posting runs the three-way match (order vs goods received vs invoice) and credits the
-- supplier's payable ledger. Supplier payment: requested by one person, APPROVED by another
-- (maker-checker, enforced here too) or REJECTED; only approved payments settle invoices.

alter table platform.companies
  add column purchase_invoice_prefix text not null default 'PI'
    check (purchase_invoice_prefix ~ '^[A-Z0-9-]{1,6}$'),
  add column supplier_payment_prefix text not null default 'PAY'
    check (supplier_payment_prefix ~ '^[A-Z0-9-]{1,6}$'),
  -- Three-way match tolerances are data, not code. These defaults are engineering choices
  -- (no quantity or price tolerance; ₹1 for rounding on totals) for the CA to confirm.
  add column match_qty_tolerance_percent numeric(6, 3) not null default 0
    check (match_qty_tolerance_percent between 0 and 100),
  add column match_price_tolerance_percent numeric(6, 3) not null default 0
    check (match_price_tolerance_percent between 0 and 100),
  add column match_total_tolerance numeric(18, 2) not null default 1.00
    check (match_total_tolerance >= 0);

-- So a purchase invoice can name the delivery it bills, and only one of its own order's.
alter table purchase.goods_receipts add constraint goods_receipts_id_order_key unique (id, order_id);

create table purchase.invoices (
  id                          uuid primary key,
  company_id                  uuid not null references platform.companies (id),
  status                      text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  -- Our own voucher number and booking date, given when posted (numbered by posting date,
  -- because suppliers' bills arrive out of date order).
  invoice_number              text,
  fiscal_year                 text,
  posting_date                date,
  supplier_id                 uuid not null,
  -- PO-based when set; a direct (non-PO) invoice otherwise.
  order_id                    uuid,
  -- The delivery this bill covers, when the supplier says so (a reference: the match itself
  -- compares against everything received on the order).
  goods_receipt_id            uuid,
  -- What the supplier printed. The normalised key catches the same bill entered twice.
  supplier_invoice_number     text not null check (length(trim(supplier_invoice_number)) between 1 and 30),
  supplier_invoice_key        text not null,
  invoice_date                date not null,
  supplier_fiscal_year        text not null,
  due_date                    date not null,
  supplier_state_code         char(2) not null references platform.states (code),
  place_of_supply_state_code  char(2) not null references platform.states (code),
  supply_type                 text not null check (supply_type in ('INTRA_STATE', 'INTER_STATE')),
  notes                       text,
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
  -- The total printed on the supplier's bill, compared with ours by the match.
  supplier_stated_total       numeric(18, 2) not null check (supplier_stated_total >= 0),
  match_status                text check (match_status in ('NOT_APPLICABLE', 'MATCHED', 'ACCEPTED_WITH_DIFFERENCES')),
  match_findings              jsonb not null default '[]',
  match_override_reason       text,
  supplier_snapshot           jsonb,
  posted_at                   timestamptz,
  posted_by                   uuid references identity.users (id),
  version                     integer not null default 1 check (version >= 1),
  created_at                  timestamptz not null default now(),
  created_by                  uuid references identity.users (id),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references identity.users (id),
  unique (company_id, invoice_number),
  unique (id, supplier_id, company_id),
  unique (company_id, supplier_id, supplier_fiscal_year, supplier_invoice_key),
  foreign key (supplier_id, company_id) references party.parties (id, company_id),
  foreign key (order_id, supplier_id, company_id) references purchase.orders (id, supplier_id, company_id),
  foreign key (goods_receipt_id, order_id) references purchase.goods_receipts (id, order_id),
  check (goods_receipt_id is null or order_id is not null),
  check (due_date >= invoice_date),
  check (posting_date is null or posting_date >= invoice_date),
  check ((status = 'DRAFT') = (invoice_number is null)),
  check (status = 'DRAFT' or (fiscal_year is not null and posting_date is not null and posted_at is not null
                              and posted_by is not null and match_status is not null
                              and supplier_snapshot is not null)),
  check (status = 'POSTED' or (posted_at is null and posting_date is null and match_status is null)),
  check (match_status is distinct from 'ACCEPTED_WITH_DIFFERENCES' or length(trim(match_override_reason)) >= 3),
  check (cgst_amount = sgst_amount),
  check (supply_type = 'INTRA_STATE' or (cgst_amount = 0 and sgst_amount = 0)),
  check (supply_type = 'INTER_STATE' or igst_amount = 0)
);

create index purchase_invoices_supplier_idx on purchase.invoices (company_id, supplier_id, invoice_date);
create index purchase_invoices_order_idx on purchase.invoices (order_id);

create trigger purchase_invoices_touch before update on purchase.invoices
  for each row execute function system.touch_updated_at();

create table purchase.invoice_lines (
  invoice_id         uuid not null references purchase.invoices (id) on delete cascade,
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
  -- The order line this bills, when the invoice is for an order.
  order_id           uuid,
  order_line_no      integer,
  primary key (invoice_id, line_no),
  check ((order_id is null) = (order_line_no is null)),
  foreign key (order_id, order_line_no) references purchase.order_lines (order_id, line_no)
);

create index purchase_invoice_lines_order_idx on purchase.invoice_lines (order_id, order_line_no);

create function purchase.guard_purchase_invoice_update() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if old.status = 'DRAFT' then
    return new;
  end if;
  -- A posted invoice never changes (corrections will be debit notes).
  if to_jsonb(new) - array['updated_at'] is distinct from to_jsonb(old) - array['updated_at'] then
    raise exception 'Purchase invoice % is posted; it is immutable', old.invoice_number using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger purchase_invoices_guard_update before update on purchase.invoices
  for each row execute function purchase.guard_purchase_invoice_update();

create function purchase.guard_purchase_invoice_delete() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if old.status <> 'DRAFT' then
    raise exception 'Purchase invoice % is posted; it cannot be deleted', old.invoice_number using errcode = 'FO002';
  end if;
  return old;
end;
$$;

create trigger purchase_invoices_guard_delete before delete on purchase.invoices
  for each row execute function purchase.guard_purchase_invoice_delete();

create function purchase.guard_purchase_invoice_lines() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  parent_status text;
  parent_order  uuid;
begin
  select status, order_id into parent_status, parent_order
    from purchase.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if parent_status is not null and parent_status <> 'DRAFT' then
    raise exception 'Lines of a posted purchase invoice are immutable' using errcode = 'FO002';
  end if;
  if tg_op <> 'DELETE' and new.order_id is not null and new.order_id is distinct from parent_order then
    raise exception 'An invoice line can only bill a line of the invoice''s own order' using errcode = 'FO002';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger purchase_invoice_lines_guard before insert or update or delete on purchase.invoice_lines
  for each row execute function purchase.guard_purchase_invoice_lines();

-- Ordered vs received vs billed, per order line (replaces the Slice 1 receiving-only view).
drop view purchase.order_line_progress;
create view purchase.order_line_progress as
  select l.order_id,
         l.line_no,
         l.item_id,
         l.quantity                                                          as ordered_quantity,
         coalesce(g.accepted, 0)::numeric(18, 3)                             as accepted_quantity,
         coalesce(g.rejected, 0)::numeric(18, 3)                             as rejected_quantity,
         (l.quantity - coalesce(g.accepted, 0))::numeric(18, 3)              as remaining_quantity,
         coalesce(b.invoiced, 0)::numeric(18, 3)                             as invoiced_quantity
    from purchase.order_lines l
    left join (
      select order_id, order_line_no, sum(accepted_quantity) as accepted, sum(rejected_quantity) as rejected
        from purchase.goods_receipt_lines group by order_id, order_line_no
    ) g on g.order_id = l.order_id and g.order_line_no = l.line_no
    left join (
      select il.order_id, il.order_line_no, sum(il.quantity) as invoiced
        from purchase.invoice_lines il join purchase.invoices i on i.id = il.invoice_id
       where i.status = 'POSTED' and il.order_id is not null
       group by il.order_id, il.order_line_no
    ) b on b.order_id = l.order_id and b.order_line_no = l.line_no;
revoke insert, update, delete on purchase.order_line_progress from factoryerp_runtime;

-- The supplier payable ledger: what we owe each supplier. Credit increases it (a posted bill),
-- debit reduces it (an approved payment). Append-only; corrections are new entries.
create table finance.payable_ledger_entries (
  id          uuid primary key,
  company_id  uuid not null references platform.companies (id),
  party_id    uuid not null,
  entry_date  date not null,
  entry_type  text not null check (entry_type in ('OPENING_BALANCE', 'PURCHASE_INVOICE', 'SUPPLIER_PAYMENT')),
  source_type text not null,
  source_id   uuid not null,
  debit       numeric(18, 2) not null default 0 check (debit >= 0),
  credit      numeric(18, 2) not null default 0 check (credit >= 0),
  narration   text,
  created_at  timestamptz not null default now(),
  created_by  uuid references identity.users (id),
  check ((debit = 0) <> (credit = 0)),
  unique (source_type, source_id, entry_type),
  foreign key (party_id, company_id) references party.parties (id, company_id)
);

create index payable_ledger_party_idx on finance.payable_ledger_entries (company_id, party_id, entry_date);

create trigger payable_ledger_append_only before update or delete on finance.payable_ledger_entries
  for each row execute function system.forbid_mutation();
create trigger payable_ledger_no_truncate before truncate on finance.payable_ledger_entries
  for each statement execute function system.forbid_mutation();
revoke update, delete on finance.payable_ledger_entries from factoryerp_runtime;

create table finance.supplier_payments (
  id                   uuid primary key,
  company_id           uuid not null references platform.companies (id),
  supplier_id          uuid not null,
  status               text not null default 'PENDING_APPROVAL'
    check (status in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  payment_number       text,
  fiscal_year          text,
  payment_date         date not null,
  amount               numeric(18, 2) not null check (amount > 0),
  payment_mode         text not null check (payment_mode in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'OTHER')),
  reference            text,
  notes                text,
  -- What the requester asked to settle; applied (and re-checked) only on approval.
  proposed_allocations jsonb not null default '[]',
  requested_at         timestamptz not null,
  requested_by         uuid not null references identity.users (id),
  approved_at          timestamptz,
  approved_by          uuid references identity.users (id),
  rejected_at          timestamptz,
  rejected_by          uuid references identity.users (id),
  rejection_reason     text,
  version              integer not null default 1 check (version >= 1),
  unique (company_id, payment_number),
  unique (id, supplier_id, company_id),
  foreign key (supplier_id, company_id) references party.parties (id, company_id),
  check ((status = 'APPROVED') = (approved_at is not null)),
  check ((approved_at is null) = (approved_by is null)),
  check ((approved_at is null) = (payment_number is null)),
  check (payment_number is null or fiscal_year is not null),
  -- Maker-checker: whoever asked for the payment cannot approve it.
  check (approved_by is null or approved_by <> requested_by),
  check ((status = 'REJECTED') = (rejected_at is not null)),
  check (rejected_at is null or (rejected_by is not null and length(trim(rejection_reason)) >= 3))
);

create index supplier_payments_supplier_idx on finance.supplier_payments (company_id, supplier_id, payment_date);

create function finance.guard_supplier_payment() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  mutable constant text[] := array[
    'status', 'payment_number', 'fiscal_year', 'version',
    'approved_at', 'approved_by', 'rejected_at', 'rejected_by', 'rejection_reason'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'Supplier payments are never deleted' using errcode = 'FO002';
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'A supplier payment''s details cannot change' using errcode = 'FO002';
  end if;
  if old.status <> 'PENDING_APPROVAL' then
    raise exception 'Supplier payment % is already %', coalesce(old.payment_number, old.id::text), old.status
      using errcode = 'FO002';
  end if;
  if new.status not in ('APPROVED', 'REJECTED') then
    raise exception 'Invalid supplier payment transition % → %', old.status, new.status using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger supplier_payments_guard before update or delete on finance.supplier_payments
  for each row execute function finance.guard_supplier_payment();
revoke delete on finance.supplier_payments from factoryerp_runtime;

create table finance.supplier_payment_allocations (
  id                  uuid primary key,
  company_id          uuid not null references platform.companies (id),
  payment_id          uuid not null references finance.supplier_payments (id),
  purchase_invoice_id uuid not null references purchase.invoices (id),
  amount              numeric(18, 2) not null check (amount > 0),
  allocated_at        timestamptz not null,
  allocated_by        uuid not null references identity.users (id)
);

create index supplier_payment_allocations_payment_idx on finance.supplier_payment_allocations (payment_id);
create index supplier_payment_allocations_invoice_idx on finance.supplier_payment_allocations (purchase_invoice_id);

create trigger supplier_payment_allocations_append_only before update or delete on finance.supplier_payment_allocations
  for each row execute function system.forbid_mutation();
create trigger supplier_payment_allocations_no_truncate before truncate on finance.supplier_payment_allocations
  for each statement execute function system.forbid_mutation();
revoke update, delete on finance.supplier_payment_allocations from factoryerp_runtime;

-- Checked at COMMIT: same company and supplier, an approved payment, a posted invoice, and
-- neither the payment nor the invoice over-allocated.
create function finance.check_supplier_allocation() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  p_company  uuid;
  p_supplier uuid;
  p_status   text;
  p_amount   numeric;
  p_alloc    numeric;
  i_company  uuid;
  i_supplier uuid;
  i_status   text;
  i_total    numeric;
  i_alloc    numeric;
begin
  select company_id, supplier_id, status, amount into p_company, p_supplier, p_status, p_amount
    from finance.supplier_payments where id = new.payment_id;
  select company_id, supplier_id, status, grand_total into i_company, i_supplier, i_status, i_total
    from purchase.invoices where id = new.purchase_invoice_id;
  if new.company_id <> p_company or new.company_id <> i_company then
    raise exception 'Allocation crosses companies' using errcode = 'FO005';
  end if;
  if p_supplier <> i_supplier then
    raise exception 'Payment and invoice belong to different suppliers' using errcode = 'FO005';
  end if;
  if p_status <> 'APPROVED' then
    raise exception 'Only an approved payment can settle invoices (payment is %)', p_status using errcode = 'FO005';
  end if;
  if i_status <> 'POSTED' then
    raise exception 'Only posted purchase invoices can be paid' using errcode = 'FO005';
  end if;
  select coalesce(sum(amount), 0) into p_alloc from finance.supplier_payment_allocations where payment_id = new.payment_id;
  if p_alloc > p_amount then
    raise exception 'Payment over-allocated: % of %', p_alloc, p_amount using errcode = 'FO005';
  end if;
  select coalesce(sum(amount), 0) into i_alloc from finance.supplier_payment_allocations where purchase_invoice_id = new.purchase_invoice_id;
  if i_alloc > i_total then
    raise exception 'Purchase invoice over-paid: % against %', i_alloc, i_total using errcode = 'FO005';
  end if;
  return null;
end;
$$;

create constraint trigger supplier_payment_allocations_settlement_check
  after insert on finance.supplier_payment_allocations
  deferrable initially deferred
  for each row execute function finance.check_supplier_allocation();

-- Derived balances (never stored).
create view finance.purchase_invoice_balances as
  select i.id                                                              as purchase_invoice_id,
         i.company_id,
         i.supplier_id,
         i.invoice_number,
         i.supplier_invoice_number,
         i.invoice_date,
         i.due_date,
         i.grand_total,
         coalesce(a.paid, 0)::numeric(18, 2)                               as paid_amount,
         (i.grand_total - coalesce(a.paid, 0))::numeric(18, 2)             as outstanding_amount
    from purchase.invoices i
    left join (
      select purchase_invoice_id, sum(amount) as paid
        from finance.supplier_payment_allocations group by purchase_invoice_id
    ) a on a.purchase_invoice_id = i.id
   where i.status = 'POSTED';

create view finance.supplier_payment_balances as
  select p.id                                                              as payment_id,
         p.company_id,
         p.supplier_id,
         p.amount,
         coalesce(a.allocated, 0)::numeric(18, 2)                          as allocated_amount,
         (p.amount - coalesce(a.allocated, 0))::numeric(18, 2)             as unallocated_amount
    from finance.supplier_payments p
    left join (
      select payment_id, sum(amount) as allocated
        from finance.supplier_payment_allocations group by payment_id
    ) a on a.payment_id = p.id
   where p.status = 'APPROVED';

revoke insert, update, delete on finance.purchase_invoice_balances, finance.supplier_payment_balances
  from factoryerp_runtime;

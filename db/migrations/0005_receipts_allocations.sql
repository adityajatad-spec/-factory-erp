-- Customer receipts and bill-wise allocation (sales-to-cash loop).
--
-- Rules (enforced here as a last line of defence; the application checks them first under
-- row locks):
--   * Receipts and allocations are append-only. Corrections will be reversal entries
--     (not built yet) — financial history is never edited or deleted.
--   * Σ allocations of a receipt ≤ receipt amount. The remainder is an unallocated
--     (on-account) credit — the explicit overpayment rule.
--   * Σ allocations to an invoice ≤ its grand total. Allocation only to ISSUED invoices of
--     the same customer and company.
--   * Invoice outstanding is DERIVED (grand total − Σ allocations); there is no editable
--     balance column anywhere.

alter table platform.companies
  add column receipt_prefix text not null default 'RCPT' check (receipt_prefix ~ '^[A-Z0-9-]{1,6}$');

create table finance.receipts (
  id             uuid primary key,
  company_id     uuid not null references platform.companies (id),
  receipt_number text not null,
  fiscal_year    text not null check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  receipt_date   date not null,
  customer_id    uuid not null references party.parties (id),
  amount         numeric(18, 2) not null check (amount > 0),
  payment_mode   text not null check (payment_mode in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'OTHER')),
  reference      text,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid not null references identity.users (id),
  unique (company_id, receipt_number)
);

create index receipts_customer_idx on finance.receipts (company_id, customer_id, receipt_date);

create trigger receipts_append_only before update or delete on finance.receipts
  for each row execute function system.forbid_mutation();
create trigger receipts_no_truncate before truncate on finance.receipts
  for each statement execute function system.forbid_mutation();

create table finance.receipt_allocations (
  id           uuid primary key,
  company_id   uuid not null references platform.companies (id),
  receipt_id   uuid not null references finance.receipts (id),
  invoice_id   uuid not null references sales.invoices (id),
  amount       numeric(18, 2) not null check (amount > 0),
  allocated_at timestamptz not null default now(),
  allocated_by uuid not null references identity.users (id)
);

create index receipt_allocations_receipt_idx on finance.receipt_allocations (receipt_id);
create index receipt_allocations_invoice_idx on finance.receipt_allocations (invoice_id);

create trigger receipt_allocations_append_only before update or delete on finance.receipt_allocations
  for each row execute function system.forbid_mutation();
create trigger receipt_allocations_no_truncate before truncate on finance.receipt_allocations
  for each statement execute function system.forbid_mutation();

-- Defence in depth: re-check every allocation invariant at COMMIT (deferred), so even a
-- buggy code path or a manual SQL insert cannot over-allocate. SQLSTATE FO003.
create function finance.check_allocation() returns trigger
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
  if i_alloc > i_total then
    raise exception 'Invoice over-paid: % allocated against a total of %', i_alloc, i_total using errcode = 'FO003';
  end if;
  return null;
end;
$$;

create constraint trigger receipt_allocations_check
  after insert on finance.receipt_allocations
  deferrable initially deferred
  for each row execute function finance.check_allocation();

-- Derived settlement position of every issued invoice.
create view finance.invoice_balances as
  select i.id                                                  as invoice_id,
         i.company_id,
         i.customer_id,
         i.invoice_number,
         i.invoice_date,
         i.grand_total,
         coalesce(sum(a.amount), 0)::numeric(18, 2)            as paid_amount,
         (i.grand_total - coalesce(sum(a.amount), 0))::numeric(18, 2) as outstanding_amount
    from sales.invoices i
    left join finance.receipt_allocations a on a.invoice_id = i.id
   where i.status = 'ISSUED'
   group by i.id;

-- Derived position of every receipt.
create view finance.receipt_balances as
  select r.id                                                  as receipt_id,
         r.company_id,
         r.customer_id,
         r.amount,
         coalesce(sum(a.amount), 0)::numeric(18, 2)            as allocated_amount,
         (r.amount - coalesce(sum(a.amount), 0))::numeric(18, 2) as unallocated_amount
    from finance.receipts r
    left join finance.receipt_allocations a on a.receipt_id = r.id
   group by r.id;

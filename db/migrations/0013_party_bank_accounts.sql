-- Supplier bank details (Slice 1): RESTRICTED data under maker-checker.
--
-- One person proposes new or changed details (PENDING_APPROVAL); a different person approves
-- them (ACTIVE — the previous ACTIVE row becomes SUPERSEDED) or rejects them. Rows are never
-- edited or deleted: every version of a supplier's bank details stays on record. Bank details
-- come only from this master, never from a bill.

create table party.bank_accounts (
  id                  uuid primary key,
  company_id          uuid not null references platform.companies (id),
  party_id            uuid not null,
  status              text not null default 'PENDING_APPROVAL'
    check (status in ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUPERSEDED')),
  account_holder_name text not null check (length(trim(account_holder_name)) between 1 and 100),
  -- Structural checks only [VERIFY R-25]: digits for the account number, the IFSC shape.
  account_number      text not null check (account_number ~ '^[0-9]{6,20}$'),
  ifsc                text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name           text check (length(bank_name) <= 100),
  branch              text check (length(branch) <= 100),
  change_reason       text not null check (length(trim(change_reason)) >= 3),
  requested_at        timestamptz not null,
  requested_by        uuid not null references identity.users (id),
  approved_at         timestamptz,
  approved_by         uuid references identity.users (id),
  rejected_at         timestamptz,
  rejected_by         uuid references identity.users (id),
  rejection_reason    text,
  superseded_at       timestamptz,
  version             integer not null default 1 check (version >= 1),
  foreign key (party_id, company_id) references party.parties (id, company_id),
  -- Maker-checker: whoever proposed the details cannot approve them.
  check (approved_by is null or approved_by <> requested_by),
  check ((approved_at is null) = (approved_by is null)),
  check ((status in ('ACTIVE', 'SUPERSEDED')) = (approved_at is not null)),
  check ((status = 'SUPERSEDED') = (superseded_at is not null)),
  check ((status = 'REJECTED') = (rejected_at is not null)),
  check (rejected_at is null or (rejected_by is not null and length(trim(rejection_reason)) >= 3))
);

create unique index bank_accounts_one_active on party.bank_accounts (party_id) where status = 'ACTIVE';
create unique index bank_accounts_one_pending on party.bank_accounts (party_id)
  where status = 'PENDING_APPROVAL';

create function party.guard_bank_account() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  mutable constant text[] := array[
    'status', 'version', 'approved_at', 'approved_by', 'rejected_at', 'rejected_by',
    'rejection_reason', 'superseded_at'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'Bank details are never deleted' using errcode = 'FO002';
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Bank details cannot be edited; propose new ones' using errcode = 'FO002';
  end if;
  if not ((old.status = 'PENDING_APPROVAL' and new.status in ('ACTIVE', 'REJECTED'))
       or (old.status = 'ACTIVE' and new.status = 'SUPERSEDED')) then
    raise exception 'Invalid bank-details transition % → %', old.status, new.status
      using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger bank_accounts_guard before update or delete on party.bank_accounts
  for each row execute function party.guard_bank_account();
revoke delete on party.bank_accounts from factoryerp_runtime;

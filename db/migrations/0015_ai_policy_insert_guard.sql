-- Database-level guard on AI policy history (P1 hardening). Every new policy version must be
-- created by an ACTIVE user holding the OWNER role in that same company, and must be exactly
-- the next version. This holds for any writer of the table — not only the application's
-- ai.policy.set command — so a policy cannot be forged around the application's checks.
--
-- Concurrency: the trigger takes the same per-company transaction lock as ai.policy.set
-- (pg_advisory_xact_lock on hashtextextended('ai.policy:' || company_id, 0)) before reading the
-- latest version, so concurrent inserts for one company serialise; the primary key remains the
-- final backstop. Update/delete/truncate protections from 0014 are unchanged.

create function ai.guard_policy_insert() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  latest integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai.policy:' || new.company_id::text, 0));

  if not exists (
    select 1
      from identity.user_roles ur
      join identity.users u on u.id = ur.user_id
     where ur.user_id = new.created_by
       and ur.company_id = new.company_id
       and ur.role_code = 'OWNER'
       and u.status = 'ACTIVE'
  ) then
    raise exception 'AI policy versions can only be created by an active owner of the company'
      using errcode = 'FO007';
  end if;

  select coalesce(max(version), 0) into latest
    from ai.policy_versions where company_id = new.company_id;
  if new.version <> latest + 1 then
    raise exception 'AI policy version must be % (got %)', latest + 1, new.version
      using errcode = 'FO007';
  end if;
  return new;
end;
$$;

create trigger policy_versions_guard_insert before insert on ai.policy_versions
  for each row execute function ai.guard_policy_insert();

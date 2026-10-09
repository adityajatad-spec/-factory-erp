-- Company AI policy (Slice 2): the only thing that can let company data reach a model.
--
-- Append-only versions per company; the latest version is the policy in force. No row means
-- AI is off for the company. Changed only through the audited OWNER command ai.policy.set;
-- the application validates the full policy with the shared contract on write AND on every
-- read, so these checks are defence in depth. Local inference only: there is no cloud
-- setting that could be switched on.

create schema ai;
grant usage on schema ai to factoryerp_runtime;
alter default privileges in schema ai
  grant select, insert, update, delete on tables to factoryerp_runtime;

create table ai.policy_versions (
  company_id    uuid not null references platform.companies (id),
  version       integer not null check (version >= 1),
  ai_enabled    boolean not null default false,
  locality      text not null default 'LOCAL_ONLY' check (locality = 'LOCAL_ONLY'),
  cloud_enabled boolean not null default false check (cloud_enabled = false),
  tasks         jsonb not null default '{}'
    check (jsonb_typeof(tasks) = 'object' and position('RESTRICTED' in tasks::text) = 0),
  reason        text not null check (length(trim(reason)) >= 3),
  created_at    timestamptz not null,
  created_by    uuid not null references identity.users (id),
  primary key (company_id, version)
);

create trigger policy_versions_append_only before update or delete on ai.policy_versions
  for each row execute function system.forbid_mutation();
create trigger policy_versions_no_truncate before truncate on ai.policy_versions
  for each statement execute function system.forbid_mutation();
revoke update, delete, truncate on ai.policy_versions from factoryerp_runtime;

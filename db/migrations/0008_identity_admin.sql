-- User administration and sign-in protection (Slice 0).

-- Optimistic concurrency for administrator edits, and a forced password change after an
-- administrator sets (or resets) a password.
alter table identity.users
  add column version integer not null default 1 check (version >= 1),
  add column must_change_password boolean not null default false,
  add column password_changed_at timestamptz;

-- Every sign-in attempt, successful or not. Append-only: it is the sign-in audit trail and the
-- source of the per-username backoff. Usernames are stored as typed (normalised to lower case)
-- whether or not such a user exists, so the backoff cannot reveal which usernames are real.
create table identity.login_attempts (
  id           uuid primary key,
  attempted_at timestamptz not null,
  username     text not null check (length(username) between 1 and 64),
  user_id      uuid references identity.users (id),
  outcome      text not null check (outcome in ('SUCCESS', 'BAD_CREDENTIALS', 'DISABLED', 'LOCKED_OUT')),
  ip           text,
  user_agent   text
);

create index login_attempts_username_idx on identity.login_attempts (username, attempted_at desc);
create index login_attempts_user_idx on identity.login_attempts (user_id, attempted_at desc);

create trigger login_attempts_append_only before update or delete on identity.login_attempts
  for each row execute function system.forbid_mutation();
create trigger login_attempts_no_truncate before truncate on identity.login_attempts
  for each statement execute function system.forbid_mutation();

-- The runtime role (default privileges from 0007) may only add and read attempts.
revoke update, delete on identity.login_attempts from factoryerp_runtime;

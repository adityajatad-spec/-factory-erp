-- Outbox operations (Slice 0).
--
-- Every event belongs to the company whose command produced it, so a company's administrators
-- can see (and retry) its failed background jobs without seeing anyone else's.

alter table system.outbox_events
  add column company_id uuid references platform.companies (id),
  add column failed_at timestamptz;

update system.outbox_events
   set company_id = (payload ->> 'companyId')::uuid
 where payload ? 'companyId';

update system.outbox_events
   set failed_at = coalesce(processed_at, available_at)
 where status = 'FAILED';

alter table system.outbox_events
  add constraint outbox_events_failed_check check ((status = 'FAILED') = (failed_at is not null));

create index outbox_company_status_idx on system.outbox_events (company_id, status, occurred_at desc);

-- Purchasing: purchase orders and goods receipts (Slice 1).
--
-- PO lifecycle (explicit; changed only by commands, guarded here):
--   DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED
--   APPROVED | PARTIALLY_RECEIVED → CLOSED      (short-closed: the rest will not come)
--   DRAFT | APPROVED (nothing received) → CANCELLED
-- RECEIVED, CLOSED and CANCELLED are final. Only drafts can be edited or deleted; an approved
-- order's content is frozen. Receiving is counted in ACCEPTED quantity: rejected goods go back
-- to the supplier and do not use up the order. Over-receipt is not allowed (FO006).

create schema purchase;
grant usage on schema purchase to factoryerp_runtime;
alter default privileges in schema purchase
  grant select, insert, update, delete on tables to factoryerp_runtime;

alter table platform.companies
  add column po_prefix  text not null default 'PO'  check (po_prefix ~ '^[A-Z0-9-]{1,6}$'),
  add column grn_prefix text not null default 'GRN' check (grn_prefix ~ '^[A-Z0-9-]{1,6}$');

create table purchase.orders (
  id                          uuid primary key,
  company_id                  uuid not null references platform.companies (id),
  status                      text not null default 'DRAFT'
    check (status in ('DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  po_number                   text,
  fiscal_year                 text,
  po_date                     date not null,
  expected_date               date,
  supplier_id                 uuid not null,
  warehouse_id                uuid not null,
  supplier_state_code         char(2) not null references platform.states (code),
  place_of_supply_state_code  char(2) not null references platform.states (code),
  supply_type                 text not null check (supply_type in ('INTRA_STATE', 'INTER_STATE')),
  notes                       text,
  -- Estimated by the shared GST engine (never accepted from clients).
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
  supplier_snapshot           jsonb,
  pdf_document_id             uuid references docs.documents (id),
  approved_at                 timestamptz,
  approved_by                 uuid references identity.users (id),
  closed_at                   timestamptz,
  closed_by                   uuid references identity.users (id),
  close_reason                text,
  cancelled_at                timestamptz,
  cancelled_by                uuid references identity.users (id),
  cancel_reason               text,
  version                     integer not null default 1 check (version >= 1),
  created_at                  timestamptz not null default now(),
  created_by                  uuid references identity.users (id),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references identity.users (id),
  unique (company_id, po_number),
  unique (id, supplier_id, company_id),
  foreign key (supplier_id, company_id) references party.parties (id, company_id),
  foreign key (warehouse_id, company_id) references inventory.warehouses (id, company_id),
  check (expected_date is null or expected_date >= po_date),
  -- Numbered exactly when approved.
  check ((po_number is null) = (approved_at is null)),
  check ((approved_at is null) = (approved_by is null)),
  check (approved_at is null or (fiscal_year is not null and supplier_snapshot is not null)),
  check (status in ('DRAFT', 'CANCELLED') or approved_at is not null),
  check (status <> 'DRAFT' or approved_at is null),
  check ((status = 'CLOSED') = (closed_at is not null)),
  check (closed_at is null or (closed_by is not null and length(trim(close_reason)) >= 3)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),
  check (cancelled_at is null or (cancelled_by is not null and length(trim(cancel_reason)) >= 3)),
  check (cgst_amount = sgst_amount),
  check (supply_type = 'INTRA_STATE' or (cgst_amount = 0 and sgst_amount = 0)),
  check (supply_type = 'INTER_STATE' or igst_amount = 0)
);

create index purchase_orders_supplier_idx on purchase.orders (company_id, supplier_id, po_date);
create index purchase_orders_status_idx on purchase.orders (company_id, status);

create trigger orders_touch before update on purchase.orders
  for each row execute function system.touch_updated_at();

create table purchase.order_lines (
  order_id           uuid not null references purchase.orders (id) on delete cascade,
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
  primary key (order_id, line_no)
);

create function purchase.guard_order_update() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  mutable constant text[] := array[
    'status', 'pdf_document_id', 'version', 'updated_at', 'updated_by',
    'closed_at', 'closed_by', 'close_reason', 'cancelled_at', 'cancelled_by', 'cancel_reason'
  ];
  allowed boolean;
begin
  if old.status = 'DRAFT' then
    if new.status not in ('DRAFT', 'APPROVED', 'CANCELLED') then
      raise exception 'Invalid purchase order transition % → %', old.status, new.status using errcode = 'FO002';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Purchase order % is %; its content is frozen', old.po_number, old.status using errcode = 'FO002';
  end if;
  if old.pdf_document_id is not null and new.pdf_document_id is distinct from old.pdf_document_id then
    raise exception 'Purchase order % already has a PDF', old.po_number using errcode = 'FO002';
  end if;
  allowed := new.status = old.status
    or (old.status = 'APPROVED' and new.status in ('PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'))
    or (old.status = 'PARTIALLY_RECEIVED' and new.status in ('RECEIVED', 'CLOSED'));
  if not allowed then
    raise exception 'Invalid purchase order transition % → %', old.status, new.status using errcode = 'FO002';
  end if;
  if old.closed_at is not null and (new.closed_at, new.closed_by, new.close_reason)
       is distinct from (old.closed_at, old.closed_by, old.close_reason) then
    raise exception 'Closing details of % cannot change', old.po_number using errcode = 'FO002';
  end if;
  if old.cancelled_at is not null and (new.cancelled_at, new.cancelled_by, new.cancel_reason)
       is distinct from (old.cancelled_at, old.cancelled_by, old.cancel_reason) then
    raise exception 'Cancellation details of % cannot change', old.po_number using errcode = 'FO002';
  end if;
  if new.status = 'CANCELLED' and old.status <> 'CANCELLED'
     and exists (select 1 from purchase.goods_receipts where order_id = old.id) then
    raise exception 'Purchase order % has goods receipts; close it instead of cancelling', old.po_number
      using errcode = 'FO002';
  end if;
  return new;
end;
$$;

create trigger orders_guard_update before update on purchase.orders
  for each row execute function purchase.guard_order_update();

create function purchase.guard_order_delete() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if old.status <> 'DRAFT' then
    raise exception 'Purchase order % is %; only drafts can be deleted', old.po_number, old.status
      using errcode = 'FO002';
  end if;
  return old;
end;
$$;

create trigger orders_guard_delete before delete on purchase.orders
  for each row execute function purchase.guard_order_delete();

create function purchase.guard_order_lines() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  parent_status text;
begin
  select status into parent_status from purchase.orders where id = coalesce(new.order_id, old.order_id);
  if parent_status is not null and parent_status <> 'DRAFT' then
    raise exception 'Lines of a % purchase order are frozen', parent_status using errcode = 'FO002';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger order_lines_guard before insert or update or delete on purchase.order_lines
  for each row execute function purchase.guard_order_lines();

-- Goods receipts: what physically arrived against an order. Immutable once recorded; its
-- accepted quantities enter stock through the inventory module in the same transaction.
create table purchase.goods_receipts (
  id                 uuid primary key,
  company_id         uuid not null references platform.companies (id),
  grn_number         text not null,
  fiscal_year        text not null,
  receipt_date       date not null,
  order_id           uuid not null,
  supplier_id        uuid not null,
  warehouse_id       uuid not null,
  supplier_reference text,
  notes              text,
  created_at         timestamptz not null default now(),
  created_by         uuid not null references identity.users (id),
  unique (company_id, grn_number),
  foreign key (order_id, supplier_id, company_id) references purchase.orders (id, supplier_id, company_id),
  foreign key (warehouse_id, company_id) references inventory.warehouses (id, company_id)
);

create index goods_receipts_order_idx on purchase.goods_receipts (order_id);

create trigger goods_receipts_append_only before update or delete on purchase.goods_receipts
  for each row execute function system.forbid_mutation();
create trigger goods_receipts_no_truncate before truncate on purchase.goods_receipts
  for each statement execute function system.forbid_mutation();

create table purchase.goods_receipt_lines (
  grn_id             uuid not null references purchase.goods_receipts (id),
  line_no            integer not null check (line_no >= 1),
  order_id           uuid not null,
  order_line_no      integer not null,
  item_id            uuid not null references catalog.items (id),
  received_quantity  numeric(18, 3) not null check (received_quantity > 0),
  accepted_quantity  numeric(18, 3) not null check (accepted_quantity >= 0),
  rejected_quantity  numeric(18, 3) not null check (rejected_quantity >= 0),
  rejection_reason   text,
  primary key (grn_id, line_no),
  unique (grn_id, order_line_no),
  foreign key (order_id, order_line_no) references purchase.order_lines (order_id, line_no),
  check (received_quantity = accepted_quantity + rejected_quantity),
  check (rejected_quantity = 0 or length(trim(rejection_reason)) >= 3)
);

create index goods_receipt_lines_order_idx on purchase.goods_receipt_lines (order_id, order_line_no);

create trigger goods_receipt_lines_append_only before update or delete on purchase.goods_receipt_lines
  for each row execute function system.forbid_mutation();
create trigger goods_receipt_lines_no_truncate before truncate on purchase.goods_receipt_lines
  for each statement execute function system.forbid_mutation();

-- Append-only for the runtime role too (default privileges granted update/delete).
revoke update, delete on purchase.goods_receipts, purchase.goods_receipt_lines from factoryerp_runtime;

-- Checked at COMMIT (after every line of the receipt and the order's new status are in place):
-- the line belongs to the receipt's order and item, the order is open, and the accepted
-- quantity never exceeds what was ordered.
create function purchase.check_goods_receipt_line() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  g_order    uuid;
  o_status   text;
  l_item     uuid;
  l_ordered  numeric;
  l_accepted numeric;
begin
  select order_id into g_order from purchase.goods_receipts where id = new.grn_id;
  if g_order <> new.order_id then
    raise exception 'Receipt line belongs to a different order' using errcode = 'FO006';
  end if;
  select status into o_status from purchase.orders where id = new.order_id;
  if o_status not in ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED') then
    raise exception 'Goods cannot be received against a % purchase order', o_status using errcode = 'FO006';
  end if;
  select item_id, quantity into l_item, l_ordered
    from purchase.order_lines where order_id = new.order_id and line_no = new.order_line_no;
  if l_item <> new.item_id then
    raise exception 'Received item does not match the order line' using errcode = 'FO006';
  end if;
  select coalesce(sum(accepted_quantity), 0) into l_accepted
    from purchase.goods_receipt_lines where order_id = new.order_id and order_line_no = new.order_line_no;
  if l_accepted > l_ordered then
    raise exception 'Over-receipt: % accepted against % ordered', l_accepted, l_ordered using errcode = 'FO006';
  end if;
  return null;
end;
$$;

create constraint trigger goods_receipt_lines_receipt_check
  after insert on purchase.goods_receipt_lines
  deferrable initially deferred
  for each row execute function purchase.check_goods_receipt_line();

-- Ordered vs received, per order line (derived; the receiving status of an order follows it).
create view purchase.order_line_progress as
  select l.order_id,
         l.line_no,
         l.item_id,
         l.quantity                                                   as ordered_quantity,
         coalesce(sum(g.accepted_quantity), 0)::numeric(18, 3)        as accepted_quantity,
         coalesce(sum(g.rejected_quantity), 0)::numeric(18, 3)        as rejected_quantity,
         (l.quantity - coalesce(sum(g.accepted_quantity), 0))::numeric(18, 3) as remaining_quantity
    from purchase.order_lines l
    left join purchase.goods_receipt_lines g
      on g.order_id = l.order_id and g.order_line_no = l.line_no
   group by l.order_id, l.line_no;

-- A purchase order PDF is a document the purchase order owns.
alter table docs.documents drop constraint documents_kind_check;
alter table docs.documents add constraint documents_kind_check
  check (kind in ('SALES_INVOICE_PDF', 'SALES_CREDIT_NOTE_PDF', 'PURCHASE_ORDER_PDF', 'UPLOAD'));

-- Views are read-only for the runtime role.
revoke insert, update, delete on purchase.order_line_progress from factoryerp_runtime;

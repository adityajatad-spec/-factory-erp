-- Inventory write path (Slice 1).
--
-- The inventory module owns every stock movement. Other modules (purchasing now; production
-- and dispatch later) call its public API inside their own transaction; they never insert
-- here. Movements stay append-only: a correction is a new, compensating movement.

-- Rows referenced across modules must belong to the same company (composite foreign keys).
alter table party.parties add constraint parties_id_company_key unique (id, company_id);
alter table catalog.items add constraint items_id_company_key unique (id, company_id);

alter table inventory.warehouses
  add column status     text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  add column created_by uuid references identity.users (id),
  add constraint warehouses_id_company_key unique (id, company_id);

-- Each movement records the unit it was counted in (a snapshot of the item's unit), a human
-- reference to its source document, and which line of that document caused it.
-- Back-filling the unit of the existing opening-stock rows is the one controlled exception to
-- the append-only rule; it happens inside this migration and nowhere else.
alter table inventory.stock_movements
  add column uom            text,
  add column reference      text,
  add column source_line_no integer check (source_line_no >= 1);

alter table inventory.stock_movements disable trigger stock_movements_append_only;
update inventory.stock_movements m set uom = i.uom from catalog.items i where i.id = m.item_id;
alter table inventory.stock_movements enable trigger stock_movements_append_only;

alter table inventory.stock_movements
  alter column uom set not null,
  add constraint stock_movements_source_check check (source_id is null or source_type is not null),
  -- Direction follows the movement type; only adjustments may go either way.
  add constraint stock_movements_sign_check check (
    (movement_type in ('OPENING', 'RECEIPT') and quantity > 0)
    or (movement_type = 'ISSUE' and quantity < 0)
    or movement_type = 'ADJUSTMENT'
  ),
  add constraint stock_movements_item_company_fk
    foreign key (item_id, company_id) references catalog.items (id, company_id),
  add constraint stock_movements_warehouse_company_fk
    foreign key (warehouse_id, company_id) references inventory.warehouses (id, company_id);

-- One movement per source document line and type: replaying a document cannot move stock twice.
create unique index stock_movements_source_line_uidx
  on inventory.stock_movements (source_type, source_id, source_line_no, movement_type)
  where source_id is not null and source_line_no is not null;
create index stock_movements_source_idx on inventory.stock_movements (source_type, source_id);

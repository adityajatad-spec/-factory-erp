import {
  CreateItemRequest,
  ItemStatusRequest,
  PERMISSIONS,
  UpdateItemRequest,
  type ItemDto,
} from '@factory-erp/contracts';
import type { z } from 'zod';
import type { DbTransaction } from '../../db/database';
import { businessDate } from '../../platform/clock';
import { defineCommand, type CommandContext, type CommandOutcome } from '../../platform/commands';
import {
  BusinessRuleError,
  DuplicateError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { selectItems, toItemDtos } from './item-dto';

async function assertUomAndHsn(tx: DbTransaction, uomCode: string, hsnCode: string) {
  const [uom, hsn] = await Promise.all([
    tx.selectFrom('catalog.uoms').select('code').where('code', '=', uomCode).executeTakeFirst(),
    tx.selectFrom('catalog.hsnCodes').select('code').where('code', '=', hsnCode).executeTakeFirst(),
  ]);
  if (!uom) throw new BusinessRuleError('UNKNOWN_UOM', `Unknown unit of measure ${uomCode}`);
  if (!hsn) throw new BusinessRuleError('UNKNOWN_HSN', `HSN code ${hsnCode} is not configured`);
}

async function loadItem(tx: DbTransaction, companyId: string, itemId: string, now: Date) {
  const row = await selectItems(tx, companyId, false)
    .where('i.id', '=', itemId)
    .executeTakeFirstOrThrow();
  const [item] = await toItemDtos(tx, [row], businessDate(now));
  if (!item) throw new Error('item not found after write');
  return item;
}

/** Lock an item for change and check the caller saw its latest version. */
async function lockItem(
  tx: DbTransaction,
  companyId: string,
  itemId: string,
  expectedVersion: number,
  now: Date,
): Promise<ItemDto> {
  const locked = await tx
    .selectFrom('catalog.items')
    .select(['id', 'version'])
    .where('companyId', '=', companyId)
    .where('id', '=', itemId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw new NotFoundError('Item');
  if (locked.version !== expectedVersion) throw new VersionConflictError('Item');
  return loadItem(tx, companyId, itemId, now);
}

/** Draft invoices that would issue this item (reads sales tables; reads may cross modules). */
async function openDraftsWithItem(tx: DbTransaction, companyId: string, itemId: string) {
  const r = await tx
    .selectFrom('sales.invoiceLines as l')
    .innerJoin('sales.invoices as i', 'i.id', 'l.invoiceId')
    .select((eb) => eb.fn.count<string>('i.id').distinct().as('n'))
    .where('i.companyId', '=', companyId)
    .where('i.status', '=', 'DRAFT')
    .where('l.itemId', '=', itemId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

const auditView = (i: ItemDto) => ({ ...i, stockOnHand: undefined });

export const createItem = defineCommand({
  name: 'items.create',
  description:
    'Create an item (raw material, component, finished good, consumable, spare or service).',
  input: CreateItemRequest,
  permission: PERMISSIONS.itemCreate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    await assertUomAndHsn(tx, input.uom, input.hsnCode);
    const existing = await tx
      .selectFrom('catalog.items')
      .select('id')
      .where('companyId', '=', companyId)
      .where('code', '=', input.code)
      .executeTakeFirst();
    if (existing) throw new DuplicateError(`Item code ${input.code} is already in use`);

    const id = uuidv7(now.getTime());
    await tx
      .insertInto('catalog.items')
      .values({
        id,
        companyId,
        code: input.code,
        name: input.name,
        description: input.description,
        itemType: input.itemType,
        uom: input.uom,
        hsnCode: input.hsnCode,
        defaultSaleRate: input.defaultSaleRate,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();

    const item = await loadItem(tx, companyId, id, now);
    return {
      result: item,
      audit: [{ entityType: 'item', entityId: id, after: { ...item, stockOnHand: undefined } }],
    };
  },
});

export const updateItem = defineCommand({
  name: 'items.update',
  description:
    'Edit an item (name, description, type, unit, HSN code, default rate). The code cannot change; issued invoices keep the details they were issued with.',
  input: UpdateItemRequest,
  permission: PERMISSIONS.itemUpdate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const before = await lockItem(tx, companyId, input.itemId, input.expectedVersion, now);
    await assertUomAndHsn(tx, input.uom, input.hsnCode);
    await tx
      .updateTable('catalog.items')
      .set({
        name: input.name,
        description: input.description,
        itemType: input.itemType,
        uom: input.uom,
        hsnCode: input.hsnCode,
        defaultSaleRate: input.defaultSaleRate,
        version: before.version + 1,
        updatedAt: now,
        updatedBy: actor.user.id,
      })
      .where('id', '=', before.id)
      .execute();
    const after = await loadItem(tx, companyId, before.id, now);
    return {
      result: after,
      audit: [
        {
          entityType: 'item',
          entityId: before.id,
          before: auditView(before),
          after: auditView(after),
        },
      ],
    };
  },
});

/** Archive or reactivate: shared by the two commands below. */
async function setItemStatus(
  { tx, actor, companyId, now }: CommandContext,
  input: z.output<typeof ItemStatusRequest>,
  target: 'ARCHIVED' | 'ACTIVE',
): Promise<CommandOutcome<ItemDto>> {
  const archiving = target === 'ARCHIVED';
  const before = await lockItem(tx, companyId, input.itemId, input.expectedVersion, now);
  if (before.status === target) {
    throw new BusinessRuleError(
      archiving ? 'ITEM_ALREADY_ARCHIVED' : 'ITEM_ALREADY_ACTIVE',
      `${before.name} is already ${archiving ? 'archived' : 'active'}`,
    );
  }
  if (archiving) {
    const drafts = await openDraftsWithItem(tx, companyId, before.id);
    if (drafts) {
      throw new BusinessRuleError(
        'ITEM_ON_OPEN_DRAFTS',
        `${before.name} is on ${drafts} draft invoice(s); remove it from them or delete the drafts first`,
      );
    }
  }
  await tx
    .updateTable('catalog.items')
    .set({
      status: target,
      version: before.version + 1,
      updatedAt: now,
      updatedBy: actor.user.id,
    })
    .where('id', '=', before.id)
    .execute();
  const after = await loadItem(tx, companyId, before.id, now);
  return {
    result: after,
    audit: [
      {
        entityType: 'item',
        entityId: before.id,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version },
      },
    ],
  };
}

export const archiveItem = defineCommand({
  name: 'items.archive',
  description:
    'Archive an item no longer in use. It disappears from pickers but nothing is deleted; refused while a draft invoice uses it.',
  input: ItemStatusRequest,
  permission: PERMISSIONS.itemUpdate,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => setItemStatus(ctx, input, 'ARCHIVED'),
});

export const reactivateItem = defineCommand({
  name: 'items.reactivate',
  description: 'Reactivate an archived item so it can be used again.',
  input: ItemStatusRequest,
  permission: PERMISSIONS.itemUpdate,
  ai: { tier: 'CONFIRM' },
  handler: (ctx, input) => setItemStatus(ctx, input, 'ACTIVE'),
});

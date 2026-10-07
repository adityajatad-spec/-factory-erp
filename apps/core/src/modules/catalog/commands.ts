import { CreateItemRequest, PERMISSIONS } from '@factory-erp/contracts';
import { businessDate } from '../../platform/clock';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, DuplicateError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { selectItems, toItemDtos } from './item-dto';

export const createItem = defineCommand({
  name: 'items.create',
  description:
    'Create an item (raw material, component, finished good, consumable, spare or service).',
  input: CreateItemRequest,
  permission: PERMISSIONS.itemCreate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const [uom, hsn, existing] = await Promise.all([
      tx.selectFrom('catalog.uoms').select('code').where('code', '=', input.uom).executeTakeFirst(),
      tx
        .selectFrom('catalog.hsnCodes')
        .select('code')
        .where('code', '=', input.hsnCode)
        .executeTakeFirst(),
      tx
        .selectFrom('catalog.items')
        .select('id')
        .where('companyId', '=', companyId)
        .where('code', '=', input.code)
        .executeTakeFirst(),
    ]);
    if (!uom) throw new BusinessRuleError('UNKNOWN_UOM', `Unknown unit of measure ${input.uom}`);
    if (!hsn)
      throw new BusinessRuleError('UNKNOWN_HSN', `HSN code ${input.hsnCode} is not configured`);
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

    const row = await selectItems(tx, companyId, false)
      .where('i.id', '=', id)
      .executeTakeFirstOrThrow();
    const [item] = await toItemDtos(tx, [row], businessDate(now));
    if (!item) throw new Error('created item not found');
    return {
      result: item,
      audit: [{ entityType: 'item', entityId: id, after: { ...item, stockOnHand: undefined } }],
    };
  },
});

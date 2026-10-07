import {
  ListItemsQuery,
  PERMISSIONS,
  Uuid,
  type HsnCodeDto,
  type ItemDto,
  type UomDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { businessDate } from '../../platform/clock';
import { NotFoundError } from '../../platform/errors';
import { defineQuery } from '../../platform/queries';
import { findEffectiveGstRates } from './gst-rates';
import { SALEABLE_TYPES, selectItems, toItemDtos } from './item-dto';

export const listItems = defineQuery({
  name: 'items.list',
  description: 'Search items by name or code, with the GST rate in force today.',
  input: ListItemsQuery,
  permission: PERMISSIONS.itemRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId, now, can }, input): Promise<ItemDto[]> => {
    let q = selectItems(db, companyId, can(PERMISSIONS.inventoryStockRead)).where(
      'i.status',
      '=',
      'ACTIVE',
    );
    if (input.itemType) q = q.where('i.itemType', '=', input.itemType);
    if (input.saleable) q = q.where('i.itemType', 'in', [...SALEABLE_TYPES]);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) => eb.or([eb('i.name', 'ilike', like), eb('i.code', 'ilike', like)]));
    }
    const rows = await q.orderBy('i.name').limit(input.limit).execute();
    return toItemDtos(db, rows, businessDate(now));
  },
});

export const getItem = defineQuery({
  name: 'items.get',
  description: 'Get one item.',
  input: z.object({ itemId: Uuid }),
  permission: PERMISSIONS.itemRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId, now, can }, input): Promise<ItemDto> => {
    const row = await selectItems(db, companyId, can(PERMISSIONS.inventoryStockRead))
      .where('i.id', '=', input.itemId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Item');
    const [dto] = await toItemDtos(db, [row], businessDate(now));
    if (!dto) throw new NotFoundError('Item');
    return dto;
  },
});

export const listHsnCodes = defineQuery({
  name: 'catalog.hsn.list',
  description: 'List HSN codes with the GST rate in force today and its verification status.',
  input: z.object({}),
  permission: PERMISSIONS.itemRead,
  ai: { tier: 'READ' },
  handler: async ({ db, now }): Promise<HsnCodeDto[]> => {
    const codes = await db
      .selectFrom('catalog.hsnCodes')
      .select(['code', 'description'])
      .orderBy('code')
      .execute();
    const rates = await findEffectiveGstRates(
      db,
      codes.map((c) => c.code),
      businessDate(now),
    );
    return codes.map((c) => ({
      ...c,
      currentRatePercent: rates.get(c.code)?.ratePercent ?? null,
      rateStatus: rates.get(c.code)?.verificationStatus ?? null,
    }));
  },
});

export const listUoms = defineQuery({
  name: 'catalog.uoms.list',
  description: 'List units of measure.',
  input: z.object({}),
  permission: PERMISSIONS.itemRead,
  ai: { tier: 'READ' },
  handler: async ({ db }): Promise<UomDto[]> =>
    db.selectFrom('catalog.uoms').select(['code', 'name']).orderBy('code').execute(),
});

import { ITEM_TYPES, type ItemDto, type ItemType } from '@factory-erp/contracts';
import { sql } from 'kysely';
import type { DbExecutor } from '../../db/database';
import { findEffectiveGstRates } from './gst-rates';

export function selectItems(db: DbExecutor, companyId: string, withStock: boolean) {
  return db
    .selectFrom('catalog.items as i')
    .select([
      'i.id',
      'i.code',
      'i.name',
      'i.description',
      'i.itemType',
      'i.uom',
      'i.hsnCode',
      'i.defaultSaleRate',
      'i.status',
      'i.version',
    ])
    .select(
      withStock
        ? sql<string>`(select coalesce(sum(m.quantity), 0)::numeric(18,3)::text
                         from inventory.stock_movements m where m.item_id = ${sql.ref('i.id')})`.as(
            'stockOnHand',
          )
        : sql<string | null>`null`.as('stockOnHand'),
    )
    .where('i.companyId', '=', companyId);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof selectItems>['execute']>>[number];

const toItemType = (t: string): ItemType => ITEM_TYPES.find((x) => x === t) ?? 'COMPONENT';

/** Map rows to DTOs, attaching the GST rate in force on `onDate`. */
export async function toItemDtos(
  db: DbExecutor,
  rows: readonly ItemRow[],
  onDate: string,
): Promise<ItemDto[]> {
  const rates = await findEffectiveGstRates(
    db,
    rows.map((r) => r.hsnCode),
    onDate,
  );
  return rows.map((r) => {
    const rate = rates.get(r.hsnCode);
    return {
      ...r,
      itemType: toItemType(r.itemType),
      status: r.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
      gstRatePercent: rate?.ratePercent ?? null,
      gstRateStatus: rate?.verificationStatus ?? null,
      stockOnHand: r.stockOnHand ?? null,
    };
  });
}

/** Item types that can appear on a sales invoice. */
export const SALEABLE_TYPES: readonly ItemType[] = ['FINISHED_GOOD', 'COMPONENT', 'SERVICE'];

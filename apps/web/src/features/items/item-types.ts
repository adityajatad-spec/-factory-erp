import type { ItemType } from '@factory-erp/contracts';

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  RAW_MATERIAL: 'Raw material',
  COMPONENT: 'Component',
  FINISHED_GOOD: 'Finished good',
  CONSUMABLE: 'Consumable',
  SPARE: 'Spare',
  SERVICE: 'Service',
};

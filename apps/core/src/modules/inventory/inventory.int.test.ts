import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, type Fixture } from '../../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../../test/test-db';
import {
  BusinessRuleError,
  DuplicateError,
  ForbiddenError,
  ValidationError,
} from '../../platform/errors';
import { getItem, updateItem } from '../catalog';
import {
  adjustStock,
  createWarehouse,
  listStock,
  listStockMovements,
  recordStockMovements,
} from './index';

const TODAY = '2026-10-05';
let env: TestEnv;
let fx: Fixture;
let main = '';
let rm = '';
const cmd = () => env.services.commands;
const qry = () => env.services.queries;

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z` });
  fx = await createFixture(env.services);
  main = (await cmd().execute(createWarehouse, { code: 'MAIN', name: 'Main' }, fx.actors.owner)).id;
  rm = (await cmd().execute(createWarehouse, { code: 'RM', name: 'Raw material' }, fx.actors.owner))
    .id;
});
afterAll(async () => env.destroy());

const adjust = (warehouseId: string, itemId: string, quantity: string, reason = 'count') =>
  cmd().execute(
    adjustStock,
    { warehouseId, adjustmentDate: TODAY, reason, lines: [{ itemId, quantity }] },
    fx.actors.owner,
  );
const onHand = async (itemId: string, warehouseId: string) =>
  (await qry().execute(listStock, { itemId, warehouseId, includeZero: 'true' }, fx.actors.owner))[0]
    ?.quantity ?? '0.000';

describe('warehouses', () => {
  it('codes are unique per company, and only managers may create them', async () => {
    await expect(
      cmd().execute(createWarehouse, { code: 'main', name: 'Again' }, fx.actors.owner),
    ).rejects.toBeInstanceOf(DuplicateError);
    await expect(
      cmd().execute(createWarehouse, { code: 'WH2', name: 'Two' }, fx.actors.accountant),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('stock is derived from the movement ledger, per item and warehouse', () => {
  it('adjustments add and remove stock in one warehouse without touching another', async () => {
    const steel = fx.items.rawMaterial.id;
    await adjust(rm, steel, '500.250');
    await adjust(main, steel, '20');
    await adjust(rm, steel, '-0.250', 'scrap found at count');
    expect(await onHand(steel, rm)).toBe('500.000');
    expect(await onHand(steel, main)).toBe('20.000');
    const moves = await qry().execute(listStockMovements, { itemId: steel }, fx.actors.owner);
    // Same date and test clock: compare as a set (ordering within a date follows creation).
    expect(moves.map((m) => m.quantity).sort()).toEqual(['-0.250', '20.000', '500.250']);
    expect(moves.every((m) => m.uom === 'KGS' && m.reference?.startsWith('ADJ/'))).toBe(true);
    expect(moves.find((m) => m.quantity === '-0.250')?.notes).toBe('scrap found at count');
  });

  it('never lets stock go below zero, and says how much there is', async () => {
    const err = await adjust(main, fx.items.rawMaterial.id, '-20.001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessRuleError);
    expect((err as BusinessRuleError).rule).toBe('INSUFFICIENT_STOCK');
    expect((err as Error).message).toMatch(/Only 20\.000 KGS/);
    expect(await onHand(fx.items.rawMaterial.id, main)).toBe('20.000');
  });

  it('concurrent removals cannot both succeed past the balance', async () => {
    const steel = fx.items.rawMaterial.id;
    const results = await Promise.allSettled([
      adjust(main, steel, '-15', 'count a'),
      adjust(main, steel, '-15', 'count b'),
      adjust(main, steel, '-15', 'count c'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(steel, main)).toBe('5.000');
  });

  it('services are not stocked; a quantity is never zero', async () => {
    const svc = await cmd().execute(
      (await import('../catalog')).createItem,
      { code: 'SVC-1', name: 'Freight', itemType: 'SERVICE', uom: 'NOS', hsnCode: '7326' },
      fx.actors.owner,
    );
    await expect(adjust(main, svc.id, '1')).rejects.toBeInstanceOf(ValidationError);
    await expect(adjust(main, fx.items.widget.id, '0')).rejects.toBeInstanceOf(ValidationError);
  });

  it('is a CONFIRM action: the AI cannot adjust stock', async () => {
    await expect(
      cmd().execute(
        adjustStock,
        {
          warehouseId: main,
          adjustmentDate: TODAY,
          reason: 'ai attempt',
          lines: [{ itemId: fx.items.widget.id, quantity: '1' }],
        },
        asAiAgent(fx.actors.owner),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the database protects the stock ledger', () => {
  it('replaying the same source line cannot move stock twice', async () => {
    const source = { type: 'test.document', id: crypto.randomUUID(), reference: 'T-1' };
    const line = { lineNo: 1, itemId: fx.items.widget.id, warehouseId: main, quantity: '3' };
    const record = () =>
      env.services.db.transaction().execute((tx) =>
        recordStockMovements(tx, {
          companyId: fx.companyId,
          movementDate: TODAY,
          movementType: 'RECEIPT',
          source,
          lines: [line],
          userId: fx.actors.owner.user.id,
          now: new Date(),
        }),
      );
    await record();
    await expect(record()).rejects.toMatchObject({ code: '23505' });
    expect(await onHand(fx.items.widget.id, main)).toBe('3.000');
  });

  it('the direction must match the movement type, even for the owner', async () => {
    await expect(
      sql`insert into inventory.stock_movements (id, company_id, item_id, warehouse_id, movement_date, movement_type, quantity, uom)
          values (${crypto.randomUUID()}, ${fx.companyId}, ${fx.items.widget.id}, ${main}, ${TODAY}, 'RECEIPT', -1, 'NOS')`.execute(
        env.ownerDb,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('movements are append-only (runtime: no privilege; owner: trigger)', async () => {
    for (const [db, code] of [
      [env.services.db, '42501'],
      [env.ownerDb, 'FO001'],
    ] as const) {
      await expect(
        sql`update inventory.stock_movements set quantity = 1`.execute(db),
      ).rejects.toMatchObject({ code });
      await expect(sql`delete from inventory.stock_movements`.execute(db)).rejects.toMatchObject({
        code,
      });
    }
  });

  it('an item that has stock cannot change its unit', async () => {
    const item = await qry().execute(getItem, { itemId: fx.items.rawMaterial.id }, fx.actors.owner);
    await expect(
      cmd().execute(
        updateItem,
        {
          itemId: item.id,
          expectedVersion: item.version,
          name: item.name,
          itemType: item.itemType,
          uom: 'NOS',
          hsnCode: item.hsnCode,
        },
        fx.actors.owner,
      ),
    ).rejects.toMatchObject({ rule: 'UOM_IN_USE' });
  });
});

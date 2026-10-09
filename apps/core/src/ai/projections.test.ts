import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../registry';
import { projectResult, TOOL_PROJECTIONS } from './projections';
import { buildToolCatalog } from './tools';

const catalog = buildToolCatalog(buildRegistry({ blobStore: {} as never }));

describe('tool result projections', () => {
  it('exist only for allowlisted READ queries', () => {
    for (const name of Object.keys(TOOL_PROJECTIONS)) {
      const tool = catalog.find((t) => t.definitionName === name);
      expect(tool, name).toBeDefined();
      expect(tool).toMatchObject({ kind: 'query', tier: 'READ' });
    }
  });

  it('keep only declared fields, at every level', () => {
    const r = projectResult(
      'inventory.warehouses.list',
      [{ id: 'w1', code: 'MAIN', name: 'Main', status: 'ACTIVE', secret: 'x', version: 3 }],
      1_000,
    );
    expect(r).toEqual({
      ok: true,
      truncated: false,
      json: '{"ok":true,"data":[{"id":"w1","code":"MAIN","name":"Main","status":"ACTIVE"}],"truncated":false}',
    });
  });

  it('refuse a result that does not match, and a tool without a projection', () => {
    expect(projectResult('inventory.warehouses.list', [{ id: 1 }], 1_000)).toEqual({
      ok: false,
      code: 'RESULT_INVALID',
    });
    expect(projectResult('sales.invoices.get', {}, 1_000)).toEqual({
      ok: false,
      code: 'RESULT_INVALID',
    });
    expect(projectResult('constructor', {}, 1_000)).toEqual({ ok: false, code: 'RESULT_INVALID' });
  });

  it('shorten a nested list to fit, keeping the totals', () => {
    const supplier = (i: number) => ({
      supplierId: `s${i}`,
      code: `S${i}`,
      name: `Supplier ${i}`,
      billedAmount: '100.00',
      paidAmount: '0.00',
      balance: '100.00',
      outstandingAmount: '100.00',
      unallocatedAmount: '0.00',
      overdueAmount: '0.00',
      dueThisWeekAmount: '0.00',
      pendingApprovalAmount: '0.00',
      openInvoiceCount: 1,
      overdueInvoiceCount: 0,
    });
    const { supplierId: _s, code: _c, name: _n, ...totals } = supplier(0);
    const raw = {
      asOf: '2026-10-09',
      totals,
      suppliers: Array.from({ length: 50 }, (_, i) => supplier(i)),
    };
    const r = projectResult('finance.payables.summary', raw, 2_000);
    expect(r.ok && r.truncated).toBe(true);
    if (!r.ok) return;
    expect(r.json.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(r.json) as {
      data: { totals: unknown; suppliers: unknown[] };
      shown: number;
      total: number;
    };
    expect(parsed.data.totals).toEqual(totals);
    expect(parsed.data.suppliers).toHaveLength(parsed.shown);
    expect(parsed.total).toBe(50);
  });
});

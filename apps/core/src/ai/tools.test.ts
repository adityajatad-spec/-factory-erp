import { resolveAiPolicy } from '@factory-erp/ai';
import { ROLE_CODES, type Permission, type RoleCode } from '@factory-erp/contracts';
import { describe, expect, it } from 'vitest';
import type { AnyCommand } from '../platform/commands';
import type { AnyQuery } from '../platform/queries';
import { DEFAULT_ROLES } from '../platform/roles';
import { buildRegistry } from '../registry';
import {
  availableTools,
  buildToolCatalog,
  checkToolCall,
  COPILOT_TOOL_ALLOWLIST,
  IDENTITY_KEYS,
  ToolCatalogError,
} from './tools';

const registry = buildRegistry({ blobStore: {} as never });
const catalog = buildToolCatalog(registry);
const COMPANY = '01900000-0000-7000-8000-00000000000c';
const UUID = '01900000-0000-7000-8000-000000000001';

function policy(over: { maxDataClass?: string; approved?: string[]; aiEnabled?: boolean } = {}) {
  const r = resolveAiPolicy(
    {
      companyId: COMPANY,
      version: 1,
      aiEnabled: over.aiEnabled ?? true,
      locality: 'LOCAL_ONLY',
      cloudEnabled: false,
      tasks: {
        'copilot.answer': {
          maxDataClass: over.maxDataClass ?? 'CONFIDENTIAL',
          approvedModels: (over.approved ?? ['ollama:qwen2.5:7b']).map((modelId) => ({
            modelId,
            p95LatencyMs: 1000,
          })),
          fallback: false,
        },
      },
    },
    COMPANY,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.policy;
}

const permissionsOf = (role: RoleCode) => new Set<Permission>(DEFAULT_ROLES[role].permissions);
const toolsFor = (role: RoleCode, p: unknown = policy()) =>
  availableTools(catalog, {
    companyId: COMPANY,
    permissions: permissionsOf(role),
    policy: p,
    task: 'copilot.answer',
  }).map((t) => t.toolName);
const owner = () =>
  availableTools(catalog, {
    companyId: COMPANY,
    permissions: permissionsOf('OWNER'),
    policy: policy(),
    task: 'copilot.answer',
  });

describe('copilot tool catalogue — derived from the registry', () => {
  it('the draft tool returns the same class of data as the query for the same record', () => {
    const draft = catalog.find((t) => t.definitionName === 'purchase.order.createDraft');
    const get = registry.queries.find((q) => q.name === 'purchase.orders.get');
    expect(draft?.dataClass).toBe(get?.dataClass);
    expect(draft?.dataClass).toBe('CONFIDENTIAL');
  });

  it('contains exactly the allowlist, each with the expected tier and data class', () => {
    expect(catalog.map((t) => t.definitionName)).toEqual(COPILOT_TOOL_ALLOWLIST.map((e) => e.name));
    for (const t of catalog) {
      expect(t.definition.ai.tier, t.definitionName).toBe(t.tier);
      if (t.kind === 'query') expect((t.definition as AnyQuery).dataClass).toBe(t.dataClass);
      expect(t.permission).toBe(t.definition.permission);
    }
  });

  it('includes nothing FORBIDDEN or CONFIRM, nothing RESTRICTED, and no bank-detail operation', () => {
    for (const t of catalog) {
      expect(['READ', 'DRAFT'], t.definitionName).toContain(t.definition.ai.tier);
      expect(t.dataClass).not.toBe('RESTRICTED');
      expect(t.definitionName).not.toMatch(/bank/i);
    }
    const forbiddenOrConfirm = [...registry.commands, ...registry.queries]
      .filter((d) => d.ai.tier === 'FORBIDDEN' || d.ai.tier === 'CONFIRM')
      .map((d) => d.name);
    expect(forbiddenOrConfirm.length).toBeGreaterThan(0);
    expect(catalog.filter((t) => forbiddenOrConfirm.includes(t.definitionName))).toEqual([]);
  });

  it('has no generic "run anything" or SQL tool', () => {
    for (const t of catalog) expect(t.toolName).not.toMatch(/sql|execute|any_command|raw/i);
    expect(catalog.length).toBe(COPILOT_TOOL_ALLOWLIST.length);
  });

  it('tool names are unique and valid; schemas are generated, objects, and deterministic', () => {
    const names = catalog.map((t) => t.toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
    for (const t of catalog) expect(t.parameters).toMatchObject({ type: 'object' });
    expect(JSON.stringify(buildToolCatalog(registry).map((t) => t.parameters))).toBe(
      JSON.stringify(catalog.map((t) => t.parameters)),
    );
  });

  it('no tool input can name an identity (company, user, actor, permissions)', () => {
    for (const t of catalog) {
      const text = JSON.stringify(t.parameters);
      for (const key of IDENTITY_KEYS) expect(text, t.toolName).not.toContain(`"${key}"`);
    }
  });

  it('fails closed if a definition drifts: tier, data class, CONFIRM/FORBIDDEN, or missing', () => {
    const swapQuery = (name: string, patch: Partial<AnyQuery>) => ({
      commands: registry.commands,
      queries: registry.queries.map((q) => (q.name === name ? { ...q, ...patch } : q)),
    });
    const swapCommand = (name: string, patch: Partial<AnyCommand>) => ({
      queries: registry.queries,
      commands: registry.commands.map((c) => (c.name === name ? { ...c, ...patch } : c)),
    });
    expect(() =>
      buildToolCatalog(swapQuery('finance.payables.summary', { ai: { tier: 'FORBIDDEN' } })),
    ).toThrow(ToolCatalogError);
    expect(() =>
      buildToolCatalog(swapQuery('inventory.stock.list', { dataClass: 'RESTRICTED' })),
    ).toThrow(/data class is RESTRICTED/);
    expect(() => buildToolCatalog(swapQuery('items.list', { dataClass: 'CONFIDENTIAL' }))).toThrow(
      /allowlist expects INTERNAL/,
    );
    expect(() =>
      buildToolCatalog(swapCommand('purchase.order.createDraft', { ai: { tier: 'CONFIRM' } })),
    ).toThrow(/AI tier is CONFIRM/);
    // The draft tool's result class is tied to the query returning the same data.
    expect(() =>
      buildToolCatalog(swapQuery('purchase.orders.get', { dataClass: 'INTERNAL' })),
    ).toThrow(
      /purchase\.order\.createDraft: result data class CONFIDENTIAL differs from purchase\.orders\.get \(INTERNAL\)/,
    );
    expect(() =>
      buildToolCatalog({
        commands: registry.commands,
        queries: registry.queries.filter((q) => q.name !== 'purchase.orders.get'),
      }),
    ).toThrow(/not a registered query/);
  });
});

describe('copilot tools — filtered per request', () => {
  it("follows each role's real permissions", () => {
    expect(toolsFor('WORKER')).toEqual([]);
    expect(toolsFor('OWNER')).toEqual(catalog.map((t) => t.toolName));
    expect(toolsFor('ADMIN')).toEqual(catalog.map((t) => t.toolName));
    const purchase = toolsFor('PURCHASE_MANAGER');
    expect(purchase).toContain('purchase_order_createDraft');
    expect(purchase).toContain('inventory_stock_list');
    expect(purchase).not.toContain('finance_payables_summary');
    const accountant = toolsFor('ACCOUNTANT');
    expect(accountant).toContain('finance_payables_summary');
    expect(accountant).not.toContain('purchase_order_createDraft');
    for (const role of ROLE_CODES) {
      const perms = permissionsOf(role);
      for (const name of toolsFor(role)) {
        const tool = catalog.find((t) => t.toolName === name);
        expect(tool && perms.has(tool.permission), `${role} ${name}`).toBe(true);
      }
    }
  });

  it('no policy, an invalid, disabled or other-company policy, or no approved model: no tools', () => {
    const p = policy();
    expect(toolsFor('OWNER', null)).toEqual([]);
    expect(toolsFor('OWNER', { ...p, cloudEnabled: true })).toEqual([]);
    expect(toolsFor('OWNER', { ...p, extra: 'field' })).toEqual([]);
    expect(toolsFor('OWNER', policy({ aiEnabled: false }))).toEqual([]);
    expect(toolsFor('OWNER', policy({ approved: [] }))).toEqual([]);
    expect(
      availableTools(catalog, {
        companyId: '01900000-0000-7000-8000-00000000000d',
        permissions: permissionsOf('OWNER'),
        policy: p,
        task: 'copilot.answer',
      }),
    ).toEqual([]);
  });

  it("the policy's data ceiling hides tools above it", () => {
    const internal = toolsFor('OWNER', policy({ maxDataClass: 'INTERNAL' }));
    expect(internal.sort()).toEqual([
      'inventory_stock_list',
      'inventory_warehouses_list',
      'items_list',
    ]);
    expect(toolsFor('OWNER', policy({ maxDataClass: 'PUBLIC' }))).toEqual([]);
  });

  it('bank details stay out even for the owner, who can read them in the UI', () => {
    expect(permissionsOf('OWNER').has('party.bank.read')).toBe(true);
    expect(owner().some((t) => /bank/i.test(t.definitionName))).toBe(false);
  });
});

describe('copilot tools — checking a model tool call (untrusted arguments)', () => {
  const tools = owner();

  it('rejects unknown tools, including real but non-tool definitions, without telling which', () => {
    for (const name of [
      'drop_tables',
      'parties_bankAccounts_list',
      'purchase_order_approve',
      'sql',
    ]) {
      expect(checkToolCall(tools, { name, arguments: {} })).toMatchObject({
        ok: false,
        code: 'UNKNOWN_TOOL',
        issues: [{ path: '', message: 'No such tool is available' }],
      });
    }
    // A tool the user may not use is just as unknown.
    const workerTools = availableTools(catalog, {
      companyId: COMPANY,
      permissions: permissionsOf('WORKER'),
      policy: policy(),
      task: 'copilot.answer',
    });
    expect(
      checkToolCall(workerTools, { name: 'finance_payables_summary', arguments: {} }),
    ).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
  });

  it('accepts a valid call and returns the schema-validated input', () => {
    const r = checkToolCall(tools, {
      name: 'finance_payables_openInvoices',
      arguments: { overdue: 'true' },
    });
    expect(r).toMatchObject({ ok: true, input: { overdue: true } });
  });

  it('rejects (does not strip) properties the tool does not declare, at any depth', () => {
    expect(
      checkToolCall(tools, { name: 'inventory_stock_list', arguments: { q: 'MS', hint: 'x' } }),
    ).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS', issues: [{ path: 'hint' }] });
    expect(
      checkToolCall(tools, {
        name: 'purchase_order_createDraft',
        arguments: {
          supplierId: UUID,
          warehouseId: UUID,
          poDate: '2026-10-09',
          lines: [{ itemId: UUID, quantity: '1', unitRate: '1', approved: true }],
        },
      }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
      issues: [{ path: 'lines.0.approved' }],
    });
  });

  it('rejects inherited JavaScript property names, at the top level and nested', () => {
    const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
    for (const name of names) {
      // JSON.parse creates them as own properties, exactly as a model's arguments arrive.
      const top: unknown = JSON.parse(`{"q":"MS","${name}":1}`);
      expect(checkToolCall(tools, { name: 'inventory_stock_list', arguments: top })).toMatchObject({
        ok: false,
        code: 'INVALID_ARGUMENTS',
        issues: [{ path: name }],
      });
      const nested: unknown = JSON.parse(
        `{"supplierId":"${UUID}","warehouseId":"${UUID}","poDate":"2026-10-09",` +
          `"lines":[{"itemId":"${UUID}","quantity":"1","unitRate":"1","${name}":{}}]}`,
      );
      expect(
        checkToolCall(tools, { name: 'purchase_order_createDraft', arguments: nested }),
      ).toMatchObject({
        ok: false,
        code: 'INVALID_ARGUMENTS',
        issues: [{ path: `lines.0.${name}` }],
      });
    }
  });

  it('hands B2 the original arguments for the bus; the parsed input would fail re-validation', () => {
    const r = checkToolCall(tools, {
      name: 'purchase_orders_list',
      arguments: { overdue: 'true' },
    });
    if (!r.ok) throw new Error('expected a valid call');
    expect(r.args).toEqual({ overdue: 'true' });
    expect(r.input).toMatchObject({ overdue: true });
    // The bus validates what it receives exactly as for an HTTP request:
    expect(r.tool.definition.input.safeParse(r.args).success).toBe(true);
    expect(r.tool.definition.input.safeParse(r.input).success).toBe(false);
  });

  it('identity cannot be chosen through arguments', () => {
    for (const key of ['companyId', 'userId', 'actorKind', 'permissions', 'roles']) {
      expect(
        checkToolCall(tools, { name: 'finance_payables_summary', arguments: { [key]: UUID } }),
      ).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS', issues: [{ path: key }] });
    }
  });

  it('rejects malformed arguments and values the definition would refuse', () => {
    expect(checkToolCall(tools, { name: 'items_list', arguments: 'everything' })).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(checkToolCall(tools, { name: 'items_list', arguments: [1, 2] })).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(
      checkToolCall(tools, { name: 'purchase_orders_get', arguments: { orderId: 'not-a-uuid' } }),
    ).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS', issues: [{ path: 'orderId' }] });
  });
});

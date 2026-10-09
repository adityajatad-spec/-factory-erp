import {
  AI_DATA_CLASS_CEILING,
  policyAllowsDataClass,
  taskRules,
  type SupportedAiTask,
  type ToolSpec,
} from '@factory-erp/ai';
import { withinDataClass, type DataClass, type Permission } from '@factory-erp/contracts';
import { z } from 'zod';
import type { AnyCommand } from '../platform/commands';
import type { AnyQuery } from '../platform/queries';

/**
 * The copilot's tools — derived from the command/query registry, never a second business API.
 *
 * B1 (this file) is pure: it builds the catalogue, filters it for one request, and validates a
 * model's tool call. It executes nothing. Execution (B2) must still, on every call:
 *   - resolve the company's policy again and re-run `availableTools` (policy may have changed);
 *   - run READ tools through the query bus and DRAFT tools through the command bus as an
 *     `ai_agent` actor built from the authenticated session (user, company, permissions), so
 *     the buses re-check permission, AI tier, validation, idempotency and audit;
 *   - never execute CONFIRM operations (they become persisted proposals in a later increment);
 *   - pass the model's original arguments (`args`) to the bus, never the parsed `input`;
 *   - cap argument and result size, project results to what the task needs (see parties.list)
 *     and map errors to safe codes.
 */

type AllowedDataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';

export interface ToolAllowlistEntry {
  name: string;
  kind: 'query' | 'command';
  tier: 'READ' | 'DRAFT';
  /**
   * The class of data the tool returns. For queries it must equal the query's own `dataClass`.
   * Commands declare none, so a command names the query that returns the same data
   * (`sameDataAs`), and the catalogue checks the two classes agree.
   */
  dataClass: AllowedDataClass;
  sameDataAs?: string;
}

/**
 * The initial, deliberately small set. Anything not listed is not a tool — including every
 * CONFIRM operation (approve, post, pay, issue), audit history, user administration, documents
 * and supplier bank details.
 */
export const COPILOT_TOOL_ALLOWLIST: readonly ToolAllowlistEntry[] = [
  { name: 'finance.payables.summary', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'finance.payables.openInvoices', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'finance.receivables.summary', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  {
    name: 'finance.receivables.openInvoices',
    kind: 'query',
    tier: 'READ',
    dataClass: 'CONFIDENTIAL',
  },
  { name: 'purchase.orders.list', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'purchase.orders.get', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'purchase.invoices.list', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'purchase.invoices.get', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'purchase.invoices.match', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'sales.invoices.list', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'sales.invoices.get', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  // Its result includes contact name, phone, email and address. The copilot's tasks need none
  // of them: B2 must project the result to id, code, name, isCustomer, isSupplier, gstin,
  // stateCode, stateName, creditDays, status and receivableBalance before the model sees it.
  { name: 'parties.list', kind: 'query', tier: 'READ', dataClass: 'CONFIDENTIAL' },
  { name: 'items.list', kind: 'query', tier: 'READ', dataClass: 'INTERNAL' },
  { name: 'inventory.stock.list', kind: 'query', tier: 'READ', dataClass: 'INTERNAL' },
  { name: 'inventory.warehouses.list', kind: 'query', tier: 'READ', dataClass: 'INTERNAL' },
  // Returns the draft purchase order: the same data as purchase.orders.get.
  {
    name: 'purchase.order.createDraft',
    kind: 'command',
    tier: 'DRAFT',
    dataClass: 'CONFIDENTIAL',
    sameDataAs: 'purchase.orders.get',
  },
];

/** Argument names that would try to choose who or where the tool runs. Never accepted. */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'companyId',
  'company_id',
  'userId',
  'user_id',
  'actor',
  'actorKind',
  'aiSessionId',
  'permissions',
  'roles',
  'tenantId',
]);

export interface CopilotTool {
  /** What the model calls: the definition name with dots as underscores. */
  toolName: string;
  definitionName: string;
  kind: 'query' | 'command';
  tier: 'READ' | 'DRAFT';
  dataClass: AllowedDataClass;
  permission: Permission;
  description: string;
  /** JSON Schema of the input, generated from the definition's Zod schema. */
  parameters: Record<string, unknown>;
  examples: readonly { description: string; input: unknown }[];
  /** The authoritative definition (validation and execution use it, never the JSON Schema). */
  definition: AnyQuery | AnyCommand;
}

export class ToolCatalogError extends Error {
  constructor(problems: readonly string[]) {
    super(`Copilot tool catalogue is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ToolCatalogError';
  }
}

const TOOL_NAME = /^[a-zA-Z0-9_]{1,64}$/;

function jsonSchemaKeys(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema as unknown[]) jsonSchemaKeys(s, out);
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const p of Object.keys(v)) out.add(p);
      }
      jsonSchemaKeys(v, out);
    }
  }
  return out;
}

/**
 * Build the catalogue from the registry. Throws (fail closed, at startup and in tests) if any
 * allowlisted definition is missing, has changed tier or data class, is FORBIDDEN or CONFIRM,
 * returns RESTRICTED data, or would let arguments name an identity.
 */
export function buildToolCatalog(registry: {
  commands: readonly AnyCommand[];
  queries: readonly AnyQuery[];
}): CopilotTool[] {
  const problems: string[] = [];
  const tools: CopilotTool[] = [];
  const seen = new Set<string>();

  for (const entry of COPILOT_TOOL_ALLOWLIST) {
    const def =
      entry.kind === 'query'
        ? registry.queries.find((q) => q.name === entry.name)
        : registry.commands.find((c) => c.name === entry.name);
    if (!def) {
      problems.push(`${entry.name}: not a registered ${entry.kind}`);
      continue;
    }
    if (def.ai.tier !== entry.tier) {
      problems.push(`${entry.name}: AI tier is ${def.ai.tier}, allowlist expects ${entry.tier}`);
      continue;
    }
    if (entry.kind === 'query' && (def as AnyQuery).dataClass !== entry.dataClass) {
      problems.push(
        `${entry.name}: data class is ${(def as AnyQuery).dataClass}, allowlist expects ${entry.dataClass}`,
      );
      continue;
    }
    if (entry.kind === 'command') {
      const reference = registry.queries.find((q) => q.name === entry.sameDataAs);
      if (!reference) {
        problems.push(`${entry.name}: names no registered query whose data its result matches`);
        continue;
      }
      if (reference.dataClass !== entry.dataClass) {
        problems.push(
          `${entry.name}: result data class ${entry.dataClass} differs from ${reference.name} (${reference.dataClass})`,
        );
        continue;
      }
    }
    if (!withinDataClass(entry.dataClass, AI_DATA_CLASS_CEILING)) {
      problems.push(`${entry.name}: ${entry.dataClass} is above the AI ceiling`);
      continue;
    }
    const toolName = entry.name.replace(/\./g, '_');
    if (!TOOL_NAME.test(toolName) || seen.has(toolName)) {
      problems.push(`${entry.name}: tool name ${toolName} is invalid or not unique`);
      continue;
    }
    seen.add(toolName);
    let parameters: Record<string, unknown>;
    try {
      parameters = z.toJSONSchema(def.input, { io: 'input' });
    } catch (e) {
      problems.push(`${entry.name}: no JSON Schema (${e instanceof Error ? e.message : 'error'})`);
      continue;
    }
    const identity = [...jsonSchemaKeys(parameters)].filter((k) => IDENTITY_KEYS.has(k));
    if (identity.length) {
      problems.push(`${entry.name}: input accepts identity fields ${identity.join(', ')}`);
      continue;
    }
    tools.push({
      toolName,
      definitionName: def.name,
      kind: entry.kind,
      tier: entry.tier,
      dataClass: entry.dataClass,
      permission: def.permission,
      description: def.description,
      parameters,
      examples: def.examples ?? [],
      definition: def,
    });
  }
  if (problems.length) throw new ToolCatalogError(problems);
  return tools;
}

/**
 * The tools one request may use: none unless the company's resolved policy has AI on, enables
 * the task with at least one approved model, and allows the tool's data class — and only
 * those whose permission the signed-in user actually holds.
 */
export function availableTools(
  catalog: readonly CopilotTool[],
  ctx: {
    companyId: string;
    permissions: ReadonlySet<Permission>;
    policy: unknown;
    task: SupportedAiTask;
  },
): CopilotTool[] {
  const rules = taskRules(ctx.policy, ctx.companyId, ctx.task);
  if (!rules || rules.approvedModels.length === 0) return [];
  return catalog.filter(
    (t) =>
      (t.tier === 'READ' || t.tier === 'DRAFT') &&
      ctx.permissions.has(t.permission) &&
      policyAllowsDataClass(rules, t.dataClass as DataClass),
  );
}

/** What the model is shown for a tool (no internal names, permissions or definitions). */
export const toToolSpec = (t: CopilotTool): ToolSpec => ({
  name: t.toolName,
  description: t.description,
  parameters: t.parameters,
});

export type ToolCallCheck =
  | {
      ok: true;
      tool: CopilotTool;
      /**
       * The model's arguments, unchanged, after the strict and schema checks. THIS is what B2
       * hands to the command/query bus, which validates it again as for any HTTP request.
       */
      args: Record<string, unknown>;
      /**
       * The schema's parsed output (transforms applied, e.g. "true" → true). For inspection
       * only: feeding it to the bus would validate transformed values a second time, which
       * fails for valid calls.
       */
      input: unknown;
    }
  | {
      ok: false;
      code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS';
      issues: readonly { path: string; message: string }[];
    };

/** Names in `value` that the JSON Schema does not declare (recursively), as dotted paths. */
function unexpectedKeys(value: unknown, schema: unknown, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = s[k];
    if (Array.isArray(branches)) {
      const list = branches as unknown[];
      const objectBranch = list.find(
        (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'object',
      );
      const arrayBranch = list.find(
        (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'array',
      );
      if (Array.isArray(value) && arrayBranch) unexpectedKeys(value, arrayBranch, path, out);
      else if (value && typeof value === 'object' && objectBranch)
        unexpectedKeys(value, objectBranch, path, out);
    }
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((v, i) => unexpectedKeys(v, s.items, `${path}${path ? '.' : ''}${i}`, out));
    return;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      // Own properties only: inherited names (constructor, toString, __proto__ …) are not
      // declared by the schema and must be rejected, not silently stripped later.
      if (!Object.hasOwn(props, k)) out.push(p);
      else unexpectedKeys(v, props[k], p, out);
    }
  }
}

/**
 * Check one tool call from the model against the tools this request may use. The model's
 * arguments are untrusted: unknown tools are rejected without saying whether they exist, any
 * property the tool does not declare (including identity fields) is rejected rather than
 * stripped, and the definition's own Zod schema then validates everything else.
 */
export function checkToolCall(
  available: readonly CopilotTool[],
  call: { name: string; arguments: unknown },
): ToolCallCheck {
  const tool = available.find((t) => t.toolName === call.name);
  if (!tool) {
    return {
      ok: false,
      code: 'UNKNOWN_TOOL',
      issues: [{ path: '', message: 'No such tool is available' }],
    };
  }
  const args = call.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENTS',
      issues: [{ path: '', message: 'Arguments must be an object' }],
    };
  }
  const extra: string[] = [];
  unexpectedKeys(args, tool.parameters, '', extra);
  const identity = Object.keys(args).filter((k) => IDENTITY_KEYS.has(k));
  const rejected = [...new Set([...identity, ...extra])];
  if (rejected.length) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENTS',
      issues: rejected.map((p) => ({ path: p, message: 'Unexpected property' })),
    };
  }
  const parsed = tool.definition.input.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENTS',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, tool, args: args as Record<string, unknown>, input: parsed.data };
}

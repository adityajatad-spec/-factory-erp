import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkArchitecture,
  generatedTables,
  TABLE_OWNERS,
  type SourceFile,
} from '../test/architecture';
import { findRepoPath } from './platform/paths';

const repo = path.dirname(findRepoPath('pnpm-workspace.yaml'));

function sources(dir: string): SourceFile[] {
  const abs = path.join(repo, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries
    .filter((e) => /\.tsx?$/.test(e) && !e.includes('node_modules'))
    .map((e) => {
      const p = `${dir}/${e.split(path.sep).join('/')}`;
      return { path: p, text: readFileSync(path.join(repo, p), 'utf8') };
    });
}

describe('the real code base', () => {
  const files = [...sources('apps/core/src'), ...sources('packages/ai/src')];
  const schema = readFileSync(path.join(repo, 'apps/core/src/db/schema.generated.ts'), 'utf8');

  it('is actually scanned (the check cannot pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const m of [
      'sales',
      'receivables',
      'finance',
      'documents',
      'identity',
      'parties',
      'catalog',
    ]) {
      expect(files.map((f) => f.path)).toContain(`apps/core/src/modules/${m}/index.ts`);
    }
    expect(generatedTables(schema).length).toBeGreaterThan(20);
  });

  it('follows every architecture rule', () => {
    expect(checkArchitecture(files, { generatedTables: generatedTables(schema) })).toEqual([]);
  });

  it('gives every table in the schema exactly one owner', () => {
    for (const t of generatedTables(schema)) expect(TABLE_OWNERS[t], t).toBeDefined();
  });
});

/** Each rule, proven to fire on a minimal file set that breaks it. */
describe('each rule catches its violation', () => {
  const core = (p: string, text: string): SourceFile => ({ path: `apps/core/src/${p}`, text });
  const rules = (files: SourceFile[], generated?: string[]) =>
    checkArchitecture(files, generated ? { generatedTables: generated } : {}).map((v) => v.rule);

  it('module-public-api: no deep imports into another module', () => {
    const files = [
      core('modules/sales/settlement.ts', 'export const x = 1;'),
      core('modules/sales/index.ts', "export { x } from './settlement';"),
      core('modules/receivables/a.ts', "import { x } from '../sales/settlement';"),
      core('modules/receivables/b.ts', "import { x } from '../sales';"),
    ];
    expect(rules(files)).toEqual(['module-public-api']);
  });

  it('module-cycle: modules may not depend on each other in a loop', () => {
    const files = [
      core('modules/a/index.ts', "import { b } from '../b';"),
      core('modules/b/index.ts', "import { a } from '../a';"),
    ];
    expect(rules(files)).toContain('module-cycle');
  });

  it('layering: platform never depends on business modules', () => {
    const files = [
      core('modules/sales/index.ts', 'export const s = 1;'),
      core('platform/x.ts', "import { s } from '../modules/sales';"),
    ];
    expect(rules(files)).toEqual(['layering']);
  });

  it('table-owner: a module writes only its own tables, never views', () => {
    expect(
      rules([core('modules/sales/x.ts', "await tx.insertInto('finance.receipts').values(v)")]),
    ).toEqual(['table-owner']);
    expect(
      rules([core('modules/finance/x.ts', "await tx.updateTable('finance.invoiceBalances')")]),
    ).toEqual(['table-owner']);
    expect(rules([core('modules/sales/x.ts', "await tx.deleteFrom('sales.mystery')")])).toEqual([
      'table-owner',
    ]);
    expect(rules([core('http/x.ts', "await tx.insertInto('sales.invoices')")])).toEqual([
      'table-owner',
    ]);
    expect(rules([], ['sales.newTable'])).toEqual(['table-owner']);
    expect(
      rules([core('modules/sales/x.ts', "await tx\n  .insertInto('sales.invoices')")]),
    ).toEqual([]);
  });

  it('table-owner: the seed may bootstrap only reference tables', () => {
    expect(rules([core('seed/x.ts', "await db.insertInto('identity.roles')")])).toEqual([]);
    expect(rules([core('seed/x.ts', "await db.insertInto('sales.invoices')")])).toEqual([
      'table-owner',
    ]);
  });

  it('writes-in-transaction: module writes use the transaction they were given', () => {
    expect(rules([core('modules/sales/x.ts', "await db.insertInto('sales.invoices')")])).toEqual([
      'writes-in-transaction',
    ]);
    expect(rules([core('modules/sales/x.ts', 'await db.transaction().execute(fn)')])).toEqual([
      'writes-in-transaction',
    ]);
    expect(
      rules([core('modules/sales/x.ts', "await ctx.tx.updateTable('sales.invoices')")]),
    ).toEqual([]);
  });

  it('queries-read-only: query files never write', () => {
    const text = "defineQuery({});\nawait tx.updateTable('sales.invoices')";
    expect(rules([core('modules/sales/queries.ts', text)])).toEqual(['queries-read-only']);
  });

  it('no-raw-dml: no hand-written SQL writes in application code', () => {
    expect(
      rules([core('modules/sales/x.ts', 'await sql`delete from sales.invoices`.execute(tx)')]),
    ).toEqual(['no-raw-dml']);
    expect(rules([core('modules/sales/x.ts', 'await sql`select 1`.execute(tx)')])).toEqual([]);
  });

  it('side-effects-via-outbox: commands do not render PDFs or write blobs', () => {
    const files = [
      core('platform/pdf.ts', 'export interface PdfRenderer {}'),
      core(
        'modules/sales/cmd.ts',
        "import type { PdfRenderer } from '../../platform/pdf';\ndefineCommand({});",
      ),
    ];
    expect(rules(files)).toEqual(['side-effects-via-outbox']);
  });

  it('no-ai-in-modules: business modules never import the AI layer', () => {
    const files = [
      core('ai/gateway.ts', 'export const g = 1;'),
      core(
        'modules/sales/x.ts',
        "import { g } from '../../ai/gateway';\nimport type { AiGateway } from '@factory-erp/ai';",
      ),
    ];
    expect(rules(files)).toEqual(['no-ai-in-modules', 'no-ai-in-modules']);
  });

  it('ai-boundary: the AI layer reaches data only through buses, contracts and module APIs', () => {
    const files = [
      core('db/database.ts', 'export type Database = unknown;'),
      core('modules/sales/index.ts', 'export const getInvoice = 1;'),
      core('modules/sales/queries.ts', 'export const getInvoice = 1;'),
      core('platform/commands.ts', 'export class CommandBus {}'),
      core(
        'ai/tools.ts',
        [
          "import type { Database } from '../db/database';",
          "import { Kysely } from 'kysely';",
          "import { getInvoice } from '../modules/sales/queries';",
          "import { getInvoice as ok } from '../modules/sales';",
          "import { CommandBus } from '../platform/commands';",
          "import { z } from 'zod';",
        ].join('\n'),
      ),
    ];
    expect(rules(files)).toEqual([
      'ai-boundary',
      'ai-boundary',
      'module-public-api',
      'ai-boundary',
    ]);
  });

  it('model-via-copilot: only the copilot entry point reaches the model', () => {
    const files = [
      core('ai/copilot.ts', 'await deps.ai.gateway.generate(ctx, req);'),
      core('ai/service.ts', 'const g = createAiGateway({});\nconst a = ollamaAdapter({});'),
      core('ai/gateway.ts', 'export function createAiGateway() { adapter.invoke(m, r, s); }'),
      core('http/ai-routes.ts', 'await deps.ai.gateway?.generate(ctx, req);'),
      core('modules/sales/x.ts', 'gw.generateStructured(ctx, req);'),
      core('ai/other.ts', 'const g = createAiGateway(cfg);\nawait adapter.invoke(m, r, s);'),
      core('ai/copilot.test.ts', 'svc.gateway.generate(ctx, req); adapter.invoke(m, r, s);'),
    ];
    expect(rules(files)).toEqual([
      'model-via-copilot', // http: calls the gateway
      'model-via-copilot', // http: reaches for it
      'model-via-copilot', // module: calls it
      'model-via-copilot', // ai/other: builds one
      'model-via-copilot', // ai/other: calls an adapter
    ]);
  });

  it('ai-package-pure: packages/ai imports only contracts and zod', () => {
    const files = [
      {
        path: 'packages/ai/src/x.ts',
        text: "import { readFile } from 'node:fs';\nimport pg from 'pg';\nimport { z } from 'zod';\nimport type { DataClass } from '@factory-erp/contracts';\nimport { y } from './y';",
      },
    ];
    expect(rules(files)).toEqual(['ai-package-pure', 'ai-package-pure']);
  });

  it('test files are exempt (tests may reach into internals)', () => {
    const files = [
      core('modules/sales/settlement.ts', 'export const x = 1;'),
      core('modules/receivables/a.test.ts', "import { x } from '../sales/settlement';"),
    ];
    expect(rules(files)).toEqual([]);
  });
});

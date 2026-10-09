/**
 * Architecture rules for the core and the AI package (docs/ROADMAP.md §6.3, §5.2), checked
 * statically over source text. Deliberately small: regular expressions over imports and Kysely
 * write calls, no dependency-analysis framework. `checkArchitecture` is pure, so every rule is
 * also tested against tiny fixtures that break it (src/architecture.test.ts).
 *
 * Test files (*.test.ts) are exempt: tests may reach into internals to prove behaviour.
 */

export interface SourceFile {
  /** Repository-relative POSIX path, e.g. "apps/core/src/modules/sales/queries.ts". */
  path: string;
  text: string;
}

export interface Violation {
  rule: string;
  file: string;
  message: string;
}

/** Owner of every table and view. A module may write only the tables it owns. */
export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  'audit.events': 'platform',
  'system.idempotencyKeys': 'platform',
  'system.numberSeries': 'platform',
  'system.outboxEvents': 'platform',
  'platform.states': 'company',
  'platform.companies': 'company',
  'identity.users': 'identity',
  'identity.userRoles': 'identity',
  'identity.roles': 'identity',
  'identity.rolePermissions': 'identity',
  'identity.sessions': 'identity',
  'identity.loginAttempts': 'identity',
  'party.parties': 'parties',
  'party.bankAccounts': 'parties',
  'catalog.items': 'catalog',
  'catalog.hsnCodes': 'catalog',
  'catalog.gstRates': 'catalog',
  'catalog.uoms': 'catalog',
  'sales.invoices': 'sales',
  'sales.invoiceLines': 'sales',
  'sales.creditNotes': 'sales',
  'sales.creditNoteLines': 'sales',
  'finance.receipts': 'receivables',
  'finance.receiptAllocations': 'receivables',
  'finance.partyLedgerEntries': 'finance',
  'docs.documents': 'documents',
  'purchase.orders': 'purchasing',
  'purchase.orderLines': 'purchasing',
  'purchase.goodsReceipts': 'purchasing',
  'purchase.goodsReceiptLines': 'purchasing',
  'purchase.invoices': 'purchasing',
  'purchase.invoiceLines': 'purchasing',
  'finance.payableLedgerEntries': 'finance',
  'finance.supplierPayments': 'payables',
  'finance.supplierPaymentAllocations': 'payables',
  'inventory.warehouses': 'inventory',
  'inventory.stockMovements': 'inventory',
  // Views are read models: nobody writes them.
  'finance.invoiceBalances': 'view',
  'finance.receiptBalances': 'view',
  'inventory.stockOnHand': 'view',
  'purchase.orderLineProgress': 'view',
  'finance.purchaseInvoiceBalances': 'view',
  'finance.supplierPaymentBalances': 'view',
};

/**
 * The demo seed bootstraps reference data and tables that have no commands yet. Business
 * documents (invoices, receipts, credit notes) it creates through the command bus like the UI.
 */
export const SEED_BOOTSTRAP_TABLES: ReadonlySet<string> = new Set([
  'identity.roles',
  'identity.rolePermissions',
  'identity.users',
  'identity.userRoles',
  'platform.companies',
  'catalog.hsnCodes',
  'catalog.gstRates',
]);

/** Files allowed to write without a transaction handle, with the reason. */
const NON_TRANSACTIONAL_WRITERS: Readonly<Record<string, string>> = {
  'apps/core/src/modules/identity/sessions.ts':
    'session bookkeeping (last-seen timestamp); createSession runs inside the login transaction',
};
/** Files that may open their own transaction instead of receiving the bus's. */
const OWN_TRANSACTION_FILES: Readonly<Record<string, string>> = {
  'apps/core/src/modules/identity/auth-service.ts': 'login/logout happen before/after any actor',
};

/** What code under apps/core/src/ai may import (the AI layer reaches data only via buses). */
const AI_ALLOWED_CORE_IMPORTS = [
  /^apps\/core\/src\/ai\//,
  /^apps\/core\/src\/modules\/[a-z-]+\/index\.ts$/,
  /^apps\/core\/src\/platform\/(commands|queries|actor|errors)\.ts$/,
];
const AI_ALLOWED_PACKAGES = new Set(['@factory-erp/contracts', '@factory-erp/ai', 'zod']);
const AI_PACKAGE_ALLOWED = new Set(['@factory-erp/contracts', 'zod']);

const CORE = 'apps/core/src/';
const WRITE_CALL = /([\w.#]+)\s*\.\s*(insertInto|updateTable|deleteFrom|mergeInto)\(\s*'([\w.]+)/g;
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;
const RAW_DML = /sql`[^`]*\b(insert\s+into|delete\s+from|truncate|update\s+[\w.]+\s+set)\b/i;

const isTest = (p: string) => p.endsWith('.test.ts') || p.endsWith('.test.tsx');

/** "module:sales", "platform", "http", "ai", "ai-package", "root" … */
export function areaOf(p: string): string {
  if (p.startsWith('packages/ai/src/')) return 'ai-package';
  if (!p.startsWith(CORE)) return 'other';
  const parts = p.slice(CORE.length).split('/');
  if (parts[0] === 'modules' && parts.length > 2) return `module:${parts[1]}`;
  return parts.length > 1 ? (parts[0] ?? 'root') : 'root';
}

function resolveRelative(from: string, spec: string, known: ReadonlySet<string>): string | null {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const base = parts.join('/');
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (known.has(c)) return c;
  return null;
}

function importsOf(file: SourceFile, known: ReadonlySet<string>) {
  const result: { spec: string; target: string | null }[] = [];
  for (const m of file.text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    result.push({
      spec,
      target: spec.startsWith('.') ? resolveRelative(file.path, spec, known) : null,
    });
  }
  return result;
}

export function checkArchitecture(
  files: readonly SourceFile[],
  opts: { generatedTables?: readonly string[] } = {},
): Violation[] {
  const v: Violation[] = [];
  const add = (rule: string, file: string, message: string) => v.push({ rule, file, message });
  const known = new Set(files.map((f) => f.path));
  const moduleEdges = new Map<string, Set<string>>();

  for (const table of opts.generatedTables ?? []) {
    if (!(table in TABLE_OWNERS)) {
      add(
        'table-owner',
        'apps/core/src/db/schema.generated.ts',
        `table ${table} has no owner in TABLE_OWNERS`,
      );
    }
  }

  for (const file of files) {
    if (isTest(file.path)) continue;
    const area = areaOf(file.path);
    const imports = importsOf(file, known);

    for (const { spec, target } of imports) {
      // --- the AI package is pure: contracts and zod only ---
      if (area === 'ai-package') {
        if (!spec.startsWith('.') && !AI_PACKAGE_ALLOWED.has(spec)) {
          add('ai-package-pure', file.path, `packages/ai may not import "${spec}"`);
        }
        continue;
      }
      if (spec === '@factory-erp/ai' && area.startsWith('module:')) {
        add('no-ai-in-modules', file.path, 'business modules must not import the AI layer');
      }
      if (!target) {
        if (area === 'ai' && !AI_ALLOWED_PACKAGES.has(spec) && !spec.startsWith('node:')) {
          add('ai-boundary', file.path, `the AI layer may not import "${spec}"`);
        }
        continue;
      }
      const targetArea = areaOf(target);

      // --- module public APIs ---
      if (targetArea.startsWith('module:') && targetArea !== area) {
        const name = targetArea.slice('module:'.length);
        if (target !== `${CORE}modules/${name}/index.ts`) {
          add(
            'module-public-api',
            file.path,
            `imports ${target}; use modules/${name} (its index.ts)`,
          );
        }
        if (area.startsWith('module:')) {
          const from = area.slice('module:'.length);
          const edges = moduleEdges.get(from) ?? new Set<string>();
          edges.add(name);
          moduleEdges.set(from, edges);
        }
      }

      // --- layering ---
      const upward = ['http', 'seed', 'ops', 'ai'];
      const rootEntry = /^apps\/core\/src\/(services|main)\.ts$/.test(target);
      if (
        (area === 'platform' || area === 'db') &&
        (targetArea.startsWith('module:') || upward.includes(targetArea) || rootEntry)
      ) {
        add('layering', file.path, `${area} must not depend on ${target}`);
      }
      if (area.startsWith('module:') && (upward.includes(targetArea) || rootEntry)) {
        add(
          targetArea === 'ai' ? 'no-ai-in-modules' : 'layering',
          file.path,
          `business modules must not import ${target}`,
        );
      }

      // --- the AI layer reaches business data only through buses and module APIs ---
      if (area === 'ai' && !AI_ALLOWED_CORE_IMPORTS.some((r) => r.test(target))) {
        add(
          'ai-boundary',
          file.path,
          `the AI layer may not import ${target} (buses, contracts and module APIs only)`,
        );
      }
    }

    // --- writes ---
    const writes = [...file.text.matchAll(WRITE_CALL)].map((m) => ({
      receiver: m[1] ?? '',
      table: (m[3] ?? '').split(' ')[0] ?? '',
    }));
    if (writes.length && file.text.includes('defineQuery(')) {
      add('queries-read-only', file.path, 'a file that defines queries must not write');
    }
    for (const w of writes) {
      const owner = TABLE_OWNERS[w.table];
      if (!owner) {
        add('table-owner', file.path, `writes ${w.table}, which has no owner in TABLE_OWNERS`);
        continue;
      }
      const allowed =
        (owner === 'platform' && area === 'platform') ||
        (owner !== 'view' && area === `module:${owner}`) ||
        (area === 'seed' && SEED_BOOTSTRAP_TABLES.has(w.table));
      if (!allowed) {
        add(
          'table-owner',
          file.path,
          owner === 'view'
            ? `writes the read-only view ${w.table}`
            : `writes ${w.table}, owned by ${owner}; call that module's public API instead`,
        );
      }
      if (
        area.startsWith('module:') &&
        !(w.receiver === 'tx' || w.receiver.endsWith('.tx')) &&
        !(file.path in NON_TRANSACTIONAL_WRITERS)
      ) {
        add(
          'writes-in-transaction',
          file.path,
          `writes ${w.table} via "${w.receiver}", not the command's transaction`,
        );
      }
    }
    if (
      area.startsWith('module:') &&
      /\.transaction\(\)/.test(file.text) &&
      !(file.path in OWN_TRANSACTION_FILES)
    ) {
      add(
        'writes-in-transaction',
        file.path,
        'modules must not open their own transactions; the command bus does',
      );
    }
    if (RAW_DML.test(file.text)) {
      add('no-raw-dml', file.path, 'raw SQL writes bypass the typed, owned write paths');
    }

    // --- side effects belong in outbox handlers, not in command transactions ---
    if (file.text.includes('defineCommand(')) {
      for (const { target } of imports) {
        if (target === `${CORE}platform/pdf.ts` || target === `${CORE}platform/blob-store.ts`) {
          add(
            'side-effects-via-outbox',
            file.path,
            `commands must not use ${target}; enqueue an outbox event`,
          );
        }
      }
    }
  }

  // --- no dependency cycles between modules ---
  const seen = new Set<string>();
  const stack: string[] = [];
  const visit = (m: string) => {
    if (stack.includes(m)) {
      const cycle = [...stack.slice(stack.indexOf(m)), m];
      add('module-cycle', `${CORE}modules/${m}`, `module dependency cycle: ${cycle.join(' → ')}`);
      return;
    }
    if (seen.has(m)) return;
    seen.add(m);
    stack.push(m);
    for (const n of moduleEdges.get(m) ?? []) visit(n);
    stack.pop();
  };
  for (const m of [...moduleEdges.keys()].sort()) visit(m);

  return v;
}

/** Table names declared in the generated Kysely schema (its `DB` interface). */
export function generatedTables(schemaSource: string): string[] {
  const body = /export interface DB \{([\s\S]*?)\n\}/.exec(schemaSource)?.[1] ?? '';
  return [...body.matchAll(/"([\w]+\.[\w]+)":/g)].map((m) => m[1] ?? '');
}

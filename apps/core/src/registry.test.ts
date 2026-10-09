import { DATA_CLASSES, isPermission } from '@factory-erp/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlobStore } from './platform/blob-store';
import { buildRegistry } from './registry';

const blobStore: BlobStore = {
  put: () => Promise.reject(new Error('unused')),
  read: () => Promise.reject(new Error('unused')),
};
const registry = buildRegistry({ blobStore });
const here = import.meta.dirname;

/** Names of every defineCommand/defineQuery in the application source (tests excluded). */
function definedNames(kind: 'Command' | 'Query'): string[] {
  const pattern = new RegExp(`define${kind}\\(\\{\\s*name:\\s*'([^']+)'`, 'g');
  return readdirSync(here, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(path.join(here, f), 'utf8').matchAll(pattern)])
    .map((m) => m[1] ?? '')
    .sort();
}

describe('the command/query registry', () => {
  it('lists every command defined in the code, once', () => {
    const names = registry.commands.map((c) => c.name).sort();
    expect(names).toEqual(definedNames('Command'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every query defined in the code, once', () => {
    const names = registry.queries.map((q) => q.name).sort();
    expect(names).toEqual(definedNames('Query'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('every command declares an AI tier from day one (DRAFT, CONFIRM or FORBIDDEN)', () => {
    for (const c of registry.commands) {
      expect(['DRAFT', 'CONFIRM', 'FORBIDDEN'], c.name).toContain(c.ai.tier);
    }
  });

  it('every query declares an AI tier (READ or FORBIDDEN) and the class of data it returns', () => {
    for (const q of registry.queries) {
      expect(['READ', 'FORBIDDEN'], q.name).toContain(q.ai.tier);
      expect(DATA_CLASSES, q.name).toContain(q.dataClass);
    }
  });

  it('only DRAFT commands may ever run for the AI; identity and operations never do', () => {
    const drafts = registry.commands.filter((c) => c.ai.tier === 'DRAFT').map((c) => c.name);
    expect(
      drafts.every((n) => /\.(createDraft|updateDraft)$/.test(n)),
      drafts.join(),
    ).toBe(true);
    for (const d of [...registry.commands, ...registry.queries]) {
      // The AI may never touch identity, operations or its own policy and records.
      if (/^(identity|operations|ai|copilot)\./.test(d.name))
        expect(d.ai.tier, d.name).toBe('FORBIDDEN');
    }
  });

  it('RESTRICTED results are never readable by the AI', () => {
    for (const q of registry.queries.filter((x) => x.dataClass === 'RESTRICTED')) {
      expect(q.ai.tier, q.name).toBe('FORBIDDEN');
    }
  });

  it('every example input is valid for its definition (examples cannot rot)', () => {
    const withExamples = [...registry.commands, ...registry.queries].filter(
      (d) => d.examples?.length,
    );
    expect(withExamples.length).toBeGreaterThanOrEqual(4);
    for (const d of withExamples) {
      for (const ex of d.examples ?? []) {
        const parsed = d.input.safeParse(ex.input);
        expect(parsed.success, `${d.name}: ${ex.description}`).toBe(true);
      }
    }
  });

  it('every definition names a real permission', () => {
    for (const d of [...registry.commands, ...registry.queries]) {
      expect(isPermission(d.permission), `${d.name}: ${d.permission}`).toBe(true);
    }
  });
});

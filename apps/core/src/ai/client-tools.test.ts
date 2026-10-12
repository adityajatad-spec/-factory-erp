import { COPILOT_TOOLS } from '@factory-erp/contracts';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../registry';
import { executable } from './copilot';
import { buildToolCatalog } from './tools';

/**
 * The web app labels lookups and suggests questions from COPILOT_TOOLS. It must describe exactly
 * the tools the copilot can execute — same names, permissions and data classes — so the UI
 * never suggests a question no tool can answer, nor hides one that exists.
 */
describe('COPILOT_TOOLS (the client-side list)', () => {
  it('matches the executable tools of the server catalogue', () => {
    const catalog = buildToolCatalog(buildRegistry({ blobStore: {} as never }));
    const server = catalog
      .filter(executable)
      .map((t) => ({ name: t.definitionName, permission: t.permission, dataClass: t.dataClass }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const client = COPILOT_TOOLS.map(({ name, permission, dataClass }) => ({
      name,
      permission,
      dataClass,
    })).sort((a, b) => a.name.localeCompare(b.name));
    expect(client).toEqual(server);
  });

  it('labels are unique and plain', () => {
    const labels = COPILOT_TOOLS.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/^[A-Z][a-z ]+$/);
  });
});

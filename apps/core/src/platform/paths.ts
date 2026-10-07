import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Locate a repository-relative path (e.g. "db/migrations") by walking up from this module.
 * Works both from src/ (tsx) and from a bundled dist/ file.
 */
export function findRepoPath(relative: string, startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate "${relative}" above ${startDir}`);
    dir = parent;
  }
}

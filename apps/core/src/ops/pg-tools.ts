import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { findRepoPath } from '../platform/paths';

/**
 * Runs pg_dump / pg_restore for backups. It prefers local client binaries whose major version
 * matches the server (pg_dump refuses newer servers). Otherwise, for a database on this machine,
 * it runs the binaries inside the Compose `db` container, which always match the server.
 * Credentials travel in PGPASSWORD, never on the command line.
 */
export interface PgTools {
  readonly mode: 'local' | 'docker';
  /** Custom-format dump; `snapshot` makes it read an exported snapshot (pg_export_snapshot). */
  dumpTo(url: string, file: string, opts?: { snapshot?: string }): Promise<void>;
  restoreFrom(url: string, file: string): Promise<void>;
}

export class PgToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgToolsError';
  }
}

interface Target {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

function parse(url: string): Target {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function localMajor(tool: string): number | null {
  const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /(\d+)(\.\d+)?/.exec(r.stdout);
  return m?.[1] ? Number(m[1]) : null;
}

/** Choose how to run the tools for a server of `serverMajor` (from `SHOW server_version_num`). */
export function resolvePgTools(serverMajor: number, url: string): PgTools {
  const forced = process.env.PG_TOOLS;
  const local = localMajor('pg_dump');
  if (forced === 'local' || (forced !== 'docker' && local === serverMajor)) {
    if (local === null) throw new PgToolsError('PG_TOOLS=local but pg_dump is not on PATH');
    return localTools();
  }
  if (!LOCAL_HOSTS.has(parse(url).host)) {
    throw new PgToolsError(
      `Install PostgreSQL ${serverMajor} client tools (pg_dump/pg_restore) to back up a remote database`,
    );
  }
  return dockerTools(path.dirname(findRepoPath('compose.yaml')));
}

function args(t: Target, extra: string[]): string[] {
  return [
    '--host',
    t.host,
    '--port',
    t.port,
    '--username',
    t.user,
    '--dbname',
    t.database,
    ...extra,
  ];
}

function dumpFlags(opts: { snapshot?: string }): string[] {
  return ['--format=custom', ...(opts.snapshot ? [`--snapshot=${opts.snapshot}`] : [])];
}

function localTools(): PgTools {
  return {
    mode: 'local',
    async dumpTo(url, file, opts = {}) {
      const t = parse(url);
      await run('pg_dump', 'pg_dump', args(t, [...dumpFlags(opts), '--file', file]), t.password);
    },
    async restoreFrom(url, file) {
      const t = parse(url);
      await run(
        'pg_restore',
        'pg_restore',
        args(t, ['--no-owner', '--exit-on-error', file]),
        t.password,
      );
    },
  };
}

function dockerTools(composeDir: string): PgTools {
  // Inside the container the server is always 127.0.0.1:5432.
  const exec = (t: Target, tool: string, extra: string[]) => [
    'compose',
    'exec',
    '-T',
    '-e',
    'PGPASSWORD',
    'db',
    tool,
    ...args({ ...t, host: '127.0.0.1', port: '5432' }, extra),
  ];
  return {
    mode: 'docker',
    async dumpTo(url, file, opts = {}) {
      const t = parse(url);
      await run('pg_dump', 'docker', exec(t, 'pg_dump', dumpFlags(opts)), t.password, {
        cwd: composeDir,
        stdoutTo: file,
      });
    },
    async restoreFrom(url, file) {
      const t = parse(url);
      await run(
        'pg_restore',
        'docker',
        exec(t, 'pg_restore', ['--no-owner', '--exit-on-error']),
        t.password,
        {
          cwd: composeDir,
          stdinFrom: file,
        },
      );
    },
  };
}

async function run(
  label: string,
  cmd: string,
  argv: string[],
  password: string,
  opts: { cwd?: string; stdoutTo?: string; stdinFrom?: string } = {},
): Promise<void> {
  const child = spawn(cmd, argv, {
    cwd: opts.cwd,
    env: { ...process.env, PGPASSWORD: password },
    stdio: [opts.stdinFrom ? 'pipe' : 'ignore', opts.stdoutTo ? 'pipe' : 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const io: Promise<void>[] = [];
  if (opts.stdoutTo && child.stdout)
    io.push(pipeline(child.stdout, createWriteStream(opts.stdoutTo)));
  if (opts.stdinFrom && child.stdin)
    io.push(pipeline(createReadStream(opts.stdinFrom), child.stdin));
  const [code] = await Promise.all([exited, ...io]);
  if (code !== 0) {
    throw new PgToolsError(`${label} failed (exit ${code}): ${stderr.trim().slice(0, 2000)}`);
  }
}

/**
 * Self-contained browser E2E run against the PRODUCTION build, on fresh demo data:
 *
 *   1. create a throwaway database (factoryerp_e2e) and seed the deterministic demo data
 *   2. start the built core (serving the built web app) on its own port and data directory
 *   3. run every journey: smoke, receivables, corrections, administration, procure-to-pay
 *   4. stop the server, drop the database, delete the data directory
 *
 * Your development database and apps/core/.data are never touched. Requires `pnpm build`,
 * TEST_DATABASE_ADMIN_URL (an account that may create databases and owns the e2e schema) and
 * DATABASE_URL (whose runtime role credentials the server uses), e.g. from the root .env.
 * Like production, the server gets only the runtime role; seeding runs as the owner.
 *
 *   pnpm build && pnpm --filter @factory-erp/web e2e
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const coreDir = path.resolve(webDir, '../core');
const DB_NAME = 'factoryerp_e2e';
const PORT = process.env.E2E_PORT ?? '3100';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JOURNEYS = [
  'smoke.ts',
  'receivables.ts',
  'corrections.ts',
  'administration.ts',
  'procurement.ts',
];

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set (see .env.example)');
const runtimeSource = process.env.DATABASE_URL;
if (!runtimeSource) throw new Error('DATABASE_URL (runtime role) is not set (see .env.example)');
for (const built of [path.join(coreDir, 'dist/main.js'), path.join(webDir, 'dist/index.html')]) {
  if (!existsSync(built)) throw new Error(`${built} is missing — run "pnpm build" first`);
}
const onE2eDb = (url: string) => {
  const u = new URL(url);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
};
const ownerUrl = onE2eDb(adminUrl);
const runtimeUrl = onE2eDb(runtimeSource);

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('core exited during startup');
    try {
      if ((await fetch(`${BASE_URL}/api/v1/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`core did not become healthy on ${BASE_URL}`);
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'ferp-e2e-'));
const logFile = path.join(dataDir, 'core.log');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: runtimeUrl,
  DATA_DIR: dataDir,
  LOG_LEVEL: 'info',
  // The journeys sign in far more often than a person; per-username backoff is still tested.
  LOGIN_RATE_LIMIT_PER_MINUTE: '120',
};
// The server never sees owner credentials (the dev .env's DATABASE_OWNER_URL points elsewhere).
delete env.DATABASE_OWNER_URL;
let server: ChildProcess | undefined;
let failed = false;

try {
  process.stdout.write(`▶ fresh database ${DB_NAME}, data dir ${dataDir}\n`);
  await admin(`drop database if exists ${DB_NAME} with (force)`);
  await admin(`create database ${DB_NAME}`);
  await run('pnpm', ['--silent', 'db:seed'], {
    cwd: coreDir,
    env: { ...env, DATABASE_OWNER_URL: ownerUrl, LOG_LEVEL: 'warn' },
  });

  process.stdout.write(`▶ starting the production build on ${BASE_URL}\n`);
  server = spawn('sh', ['-c', `exec node dist/main.js > "${logFile}" 2>&1`], {
    cwd: coreDir,
    env: { ...env, HOST: '127.0.0.1', PORT, WEB_DIST_DIR: path.join(webDir, 'dist') },
    stdio: 'inherit',
  });
  await waitForHealth(server);

  for (const journey of JOURNEYS) {
    process.stdout.write(`\n▶ ${journey}\n`);
    try {
      await run('pnpm', ['exec', 'tsx', path.join('e2e', journey)], {
        cwd: webDir,
        env: { ...process.env, BASE_URL },
      });
    } catch (err) {
      failed = true;
      process.stdout.write(
        `✗ ${journey} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
} catch (err) {
  failed = true;
  process.stdout.write(`✗ e2e setup failed: ${err instanceof Error ? err.stack : String(err)}\n`);
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server?.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  const log = existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
  // pino levels: 50 = error, 60 = fatal.
  const errors = log.split('\n').filter((l) => /"level":(50|60)/.test(l));
  process.stdout.write(`\n▶ server error log lines: ${errors.length}\n`);
  if (errors.length) {
    failed = true;
    process.stdout.write(`${errors.slice(0, 20).join('\n')}\n`);
  }
  await admin(`drop database if exists ${DB_NAME} with (force)`).catch((e: unknown) => {
    process.stdout.write(`warning: could not drop ${DB_NAME}: ${String(e)}\n`);
  });
  await rm(dataDir, { recursive: true, force: true });
  process.stdout.write(`▶ cleaned up (${DB_NAME} dropped, data dir removed)\n`);
}

process.stdout.write(failed ? '\nE2E FAILED\n' : '\nE2E PASSED — all journeys green\n');
process.exitCode = failed ? 1 : 0;

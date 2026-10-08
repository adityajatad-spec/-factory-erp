import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { latestMigrationVersion } from '../db/migrate';
import { RUNTIME_GROUP_ROLE } from '../db/roles';
import type { Logger } from '../logger';
import { sha256Hex } from '../platform/json';
import { APP_VERSION } from '../version';
import { resolvePgTools, type PgTools } from './pg-tools';

/**
 * Backup and restore for a single factory node (Slice 0).
 *
 * A backup is one directory:
 *   database.dump   pg_dump custom format, taken by the schema OWNER
 *   blobs/          a copy of the content-addressed blob store (generated PDFs)
 *   manifest.json   versions, checksums and row counts taken in the dump's own snapshot
 *
 * Consistency: the dump reads an exported snapshot, and the counts are taken in that same
 * snapshot. Blobs are copied after the dump; because a blob is always written before the row
 * that references it commits, and blobs are never deleted, every document in the dump has its
 * blob in the backup. A directory only gets its final name once it is complete.
 */
export const BACKUP_FORMAT = 'factory-erp-backup/1';

const COUNTED_TABLES = [
  'platform.companies',
  'identity.users',
  'party.parties',
  'catalog.items',
  'sales.invoices',
  'sales.credit_notes',
  'finance.receipts',
  'finance.receipt_allocations',
  'finance.party_ledger_entries',
  'docs.documents',
  'audit.events',
  'inventory.stock_movements',
] as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  appVersion: string;
  schemaVersion: string;
  serverVersion: string;
  database: { file: 'database.dump'; sha256: string; bytes: number };
  blobs: { count: number; bytes: number };
  counts: Record<string, number>;
}

export class BackupError extends Error {
  readonly problems: readonly string[];
  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length ? `${message}:\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'BackupError';
    this.problems = problems;
  }
}

const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BLOB_KEY = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

const withDatabase = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: 'factory-erp-backup' });
  await client.connect();
  return client;
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Every blob under `root` (a blobs directory), as storage keys "sha256/ab/cd/<hash>". */
async function listBlobKeys(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    },
  );
  return entries
    .filter((e) => e.isFile() && !e.name.endsWith('.tmp'))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

async function serverMajor(client: pg.Client): Promise<{ major: number; version: string }> {
  const { rows } = await client.query<{ n: string; v: string }>(
    `select current_setting('server_version_num') as n, current_setting('server_version') as v`,
  );
  return { major: Math.floor(Number(rows[0]?.n) / 10_000), version: rows[0]?.v ?? '?' };
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Take a backup of the database (as its OWNER) and the blob store into `backupRoot`. */
export async function createBackup(opts: {
  ownerUrl: string;
  dataDir: string;
  backupRoot: string;
  now?: Date;
  tools?: PgTools;
  logger?: Pick<Logger, 'info'>;
}): Promise<{ dir: string; manifest: BackupManifest }> {
  const now = opts.now ?? new Date();
  const dir = path.join(opts.backupRoot, `factoryerp-${stamp(now)}`);
  const staging = `${dir}.partial`;
  await mkdir(staging, { recursive: true });
  const dumpFile = path.join(staging, 'database.dump');

  const client = await connect(opts.ownerUrl);
  let server: { major: number; version: string };
  const counts: Record<string, number> = {};
  let schemaVersion: string;
  try {
    server = await serverMajor(client);
    const tools = opts.tools ?? resolvePgTools(server.major, opts.ownerUrl);
    // Export one snapshot; count rows in it and let pg_dump read exactly the same data.
    await client.query('begin isolation level repeatable read read only');
    const snapshot = (await client.query<{ s: string }>('select pg_export_snapshot() as s')).rows[0]
      ?.s;
    if (!snapshot) throw new BackupError('Could not export a snapshot');
    for (const table of COUNTED_TABLES) {
      const r = await client.query<{ n: string }>(`select count(*) as n from ${table}`);
      counts[table] = Number(r.rows[0]?.n ?? 0);
    }
    const v = await client.query<{ v: string | null }>(
      'select max(version) as v from system.schema_migrations',
    );
    schemaVersion = v.rows[0]?.v ?? '';
    await tools.dumpTo(opts.ownerUrl, dumpFile, { snapshot });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }

  // Blobs: copy and verify each one against its content address.
  const source = path.join(opts.dataDir, 'blobs');
  const keys = await listBlobKeys(source);
  let blobBytes = 0;
  for (const key of keys) {
    if (!BLOB_KEY.test(key)) continue;
    const bytes = await readFile(path.join(source, key));
    if (sha256Hex(bytes) !== key.slice(-64)) {
      throw new BackupError(`Blob store is corrupt: ${key} does not match its checksum`);
    }
    const target = path.join(staging, 'blobs', key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    blobBytes += bytes.length;
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
    schemaVersion,
    serverVersion: server.version,
    database: {
      file: 'database.dump',
      sha256: await fileSha256(dumpFile),
      bytes: (await stat(dumpFile)).size,
    },
    blobs: { count: keys.filter((k) => BLOB_KEY.test(k)).length, bytes: blobBytes },
    counts,
  };
  await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staging, dir);
  opts.logger?.info({ dir, blobs: manifest.blobs.count, counts }, 'backup complete');
  return { dir, manifest };
}

/** Check a backup directory without touching any database: manifest, dump and every blob. */
export async function verifyBackupFiles(
  dir: string,
): Promise<{ manifest: BackupManifest; problems: string[] }> {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
  } catch {
    throw new BackupError(`${dir} is not a complete backup (manifest.json missing or unreadable)`);
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new BackupError(`Unsupported backup format "${String(manifest.format)}"`);
  }

  const dump = path.join(dir, manifest.database.file);
  const dumpStat = await stat(dump).catch(() => null);
  if (!dumpStat) problems.push('database.dump is missing');
  else if (
    dumpStat.size !== manifest.database.bytes ||
    (await fileSha256(dump)) !== manifest.database.sha256
  ) {
    problems.push('database.dump does not match its recorded checksum');
  }

  const keys = (await listBlobKeys(path.join(dir, 'blobs'))).filter((k) => BLOB_KEY.test(k));
  let bytes = 0;
  for (const key of keys) {
    const content = await readFile(path.join(dir, 'blobs', key));
    bytes += content.length;
    if (sha256Hex(content) !== key.slice(-64)) problems.push(`blob ${key} is corrupt`);
  }
  if (keys.length !== manifest.blobs.count || bytes !== manifest.blobs.bytes) {
    problems.push(
      `blob store has ${keys.length} files / ${bytes} bytes; the manifest recorded ${manifest.blobs.count} / ${manifest.blobs.bytes}`,
    );
  }
  return { manifest, problems };
}

/**
 * Integrity checks on a restored database: schema version, row counts, every document's blob
 * present and intact, and the receivables reconciliation (ledger = outstanding − unallocated).
 */
export async function checkRestoredDatabase(
  url: string,
  manifest: BackupManifest,
  blobRoot: string,
): Promise<string[]> {
  const problems: string[] = [];
  const client = await connect(url);
  try {
    const v = await client.query<{ v: string | null }>(
      'select max(version) as v from system.schema_migrations',
    );
    if (v.rows[0]?.v !== manifest.schemaVersion) {
      problems.push(`schema version ${v.rows[0]?.v ?? 'none'} ≠ ${manifest.schemaVersion}`);
    }
    // Table names come from the fixed list, never from the (untrusted) manifest file.
    for (const table of COUNTED_TABLES) {
      const expected = manifest.counts[table];
      const r = await client.query<{ n: string }>(`select count(*) as n from ${table}`);
      const n = Number(r.rows[0]?.n ?? -1);
      if (n !== expected) problems.push(`${table}: ${n} rows restored, ${expected} backed up`);
    }

    const docs = await client.query<{ storage_key: string; sha256: string }>(
      'select storage_key, sha256 from docs.documents',
    );
    for (const d of docs.rows) {
      const content = await readFile(path.join(blobRoot, d.storage_key)).catch(() => null);
      if (!content) problems.push(`document blob ${d.storage_key} is missing`);
      else if (sha256Hex(content) !== d.sha256)
        problems.push(`document blob ${d.storage_key} is corrupt`);
    }

    const recon = await client.query<{ party_id: string; ledger: string; derived: string }>(`
      with ledger as (
        select party_id, sum(debit - credit) as amount from finance.party_ledger_entries group by 1
      ), outstanding as (
        select customer_id as party_id, sum(outstanding_amount) as amount
        from finance.invoice_balances group by 1
      ), unallocated as (
        select customer_id as party_id, sum(unallocated_amount) as amount
        from finance.receipt_balances group by 1
      )
      select p.id as party_id, coalesce(l.amount, 0)::text as ledger,
             (coalesce(o.amount, 0) - coalesce(u.amount, 0))::text as derived
      from party.parties p
      left join ledger l on l.party_id = p.id
      left join outstanding o on o.party_id = p.id
      left join unallocated u on u.party_id = p.id
      where coalesce(l.amount, 0) <> coalesce(o.amount, 0) - coalesce(u.amount, 0)`);
    for (const r of recon.rows) {
      problems.push(
        `party ${r.party_id}: ledger ${r.ledger} ≠ outstanding − unallocated ${r.derived}`,
      );
    }

    const guards = await client.query<{ n: string }>(`
      select count(distinct t.tgrelid) as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where p.proname = 'forbid_mutation' and not t.tgisinternal`);
    if (Number(guards.rows[0]?.n ?? 0) < 6) problems.push('append-only triggers are missing');
  } finally {
    await client.end();
  }
  return problems;
}

async function databaseExists(admin: pg.Client, name: string): Promise<boolean> {
  const r = await admin.query('select 1 from pg_database where datname = $1', [name]);
  return r.rowCount === 1;
}

/** Create `database` and restore the dump into it, as the owner of `ownerUrl`. */
async function restoreDump(opts: {
  ownerUrl: string;
  database: string;
  dumpFile: string;
  tools?: PgTools;
}): Promise<string> {
  if (!DB_NAME.test(opts.database)) {
    throw new BackupError(`"${opts.database}" is not a plain lowercase database name`);
  }
  const owner = decodeURIComponent(new URL(opts.ownerUrl).username);
  const admin = await connect(withDatabase(opts.ownerUrl, 'postgres'));
  let tools: PgTools;
  try {
    if (await databaseExists(admin, opts.database)) {
      throw new BackupError(
        `Database "${opts.database}" already exists. A restore never overwrites a database: restore into a new name, then switch over.`,
      );
    }
    tools = opts.tools ?? resolvePgTools((await serverMajor(admin)).major, opts.ownerUrl);
    // Roles are cluster-wide and not in the dump; the grants in it need the runtime group.
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${RUNTIME_GROUP_ROLE}') then
        create role ${RUNTIME_GROUP_ROLE} nologin;
      end if; end $$`);
    await admin.query(`create database "${opts.database}" owner "${owner}"`);
  } finally {
    await admin.end();
  }
  const target = withDatabase(opts.ownerUrl, opts.database);
  await tools.restoreFrom(target, opts.dumpFile);
  return target;
}

async function dropDatabase(ownerUrl: string, database: string): Promise<void> {
  const admin = await connect(withDatabase(ownerUrl, 'postgres'));
  try {
    await admin.query(`drop database if exists "${database}" with (force)`);
  } finally {
    await admin.end();
  }
}

/**
 * The restore drill: verify the files, restore into a throwaway database, run the integrity
 * checks against the backup's own blobs, then drop the throwaway database.
 */
export async function verifyBackup(opts: {
  dir: string;
  ownerUrl: string;
  tools?: PgTools;
}): Promise<{ manifest: BackupManifest; problems: string[] }> {
  const { manifest, problems } = await verifyBackupFiles(opts.dir);
  if (problems.length) return { manifest, problems };
  const scratch = `ferp_restore_drill_${randomBytes(4).toString('hex')}`;
  try {
    const url = await restoreDump({
      ownerUrl: opts.ownerUrl,
      database: scratch,
      dumpFile: path.join(opts.dir, manifest.database.file),
      ...(opts.tools ? { tools: opts.tools } : {}),
    });
    problems.push(...(await checkRestoredDatabase(url, manifest, path.join(opts.dir, 'blobs'))));
  } finally {
    await dropDatabase(opts.ownerUrl, scratch);
  }
  return { manifest, problems };
}

/**
 * Restore a backup into a NEW database and merge its blobs into `dataDir`. Afterwards point
 * DATABASE_URL / DATABASE_OWNER_URL at the new database (or rename databases) and restart.
 */
export async function restoreBackup(opts: {
  dir: string;
  ownerUrl: string;
  database: string;
  dataDir: string;
  tools?: PgTools;
}): Promise<{ manifest: BackupManifest; url: string; blobsCopied: number }> {
  const { manifest, problems } = await verifyBackupFiles(opts.dir);
  if (problems.length)
    throw new BackupError('Backup failed verification; nothing restored', problems);
  const expected = await latestMigrationVersion();
  if (manifest.schemaVersion > (expected ?? '')) {
    throw new BackupError(
      `Backup schema ${manifest.schemaVersion} is newer than this build (${expected}); restore with a matching or newer build`,
    );
  }

  const url = await restoreDump({
    ownerUrl: opts.ownerUrl,
    database: opts.database,
    dumpFile: path.join(opts.dir, manifest.database.file),
    ...(opts.tools ? { tools: opts.tools } : {}),
  });

  // Content-addressed: an existing file with the same name has the same content.
  const source = path.join(opts.dir, 'blobs');
  const target = path.join(opts.dataDir, 'blobs');
  let blobsCopied = 0;
  for (const key of (await listBlobKeys(source)).filter((k) => BLOB_KEY.test(k))) {
    const to = path.join(target, key);
    const existing = await readFile(to).catch(() => null);
    if (existing && sha256Hex(existing) === key.slice(-64)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(path.join(source, key), to);
    blobsCopied++;
  }

  const after = await checkRestoredDatabase(url, manifest, target);
  if (after.length) {
    throw new BackupError(`Restored into "${opts.database}" but integrity checks failed`, after);
  }
  return { manifest, url, blobsCopied };
}

import { sql } from 'kysely';
import pg from 'pg';
import type { Logger } from '../logger';
import type { DbExecutor } from './database';

/**
 * The database role model (docs/ARCHITECTURE.md §P, Slice 0):
 *
 * - OWNER (DATABASE_OWNER_URL) owns the schema. It runs migrations, backups and restores.
 * - RUNTIME (DATABASE_URL) is a LOGIN role that belongs to the `factoryerp_runtime` group role
 *   (created by migration 0007). It reads and writes rows; it cannot change the schema,
 *   disable triggers, truncate, or update/delete append-only rows.
 */
export const RUNTIME_GROUP_ROLE = 'factoryerp_runtime';

export const APP_SCHEMAS = [
  'platform',
  'identity',
  'audit',
  'system',
  'party',
  'catalog',
  'sales',
  'finance',
  'docs',
  'inventory',
  'purchase',
  'ai',
] as const;

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class DatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseRoleError';
  }
}

function credentialsOf(url: string): { user: string; password: string } {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

/**
 * Make sure the runtime LOGIN role named in `runtimeUrl` exists and belongs to the runtime
 * group. Run with the owner connection after migrating (it needs CREATEROLE).
 *
 * It creates a missing role with the URL's password, but never changes an existing role's
 * password, and it refuses a role that carries any administrative attribute.
 */
export async function ensureRuntimeLogin(
  ownerUrl: string,
  runtimeUrl: string,
  logger?: Pick<Logger, 'info'>,
): Promise<void> {
  const { user, password } = credentialsOf(runtimeUrl);
  if (user === credentialsOf(ownerUrl).user) {
    throw new DatabaseRoleError(
      'DATABASE_URL must use the runtime role, not the owner role in DATABASE_OWNER_URL',
    );
  }
  if (!ROLE_NAME.test(user)) {
    throw new DatabaseRoleError(`Runtime role name "${user}" is not a plain lowercase name`);
  }

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const existing = await client.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
         from pg_roles where rolname = $1`,
      [user],
    );
    const role = existing.rows[0];
    if (!role) {
      if (!password)
        throw new DatabaseRoleError('DATABASE_URL has no password for the runtime role');
      await client.query(
        `create role "${user}" login password ${client.escapeLiteral(password)}
           nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`,
      );
      logger?.info({ role: user }, 'runtime database role created');
    } else if (
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolbypassrls
    ) {
      throw new DatabaseRoleError(
        `Runtime role "${user}" has administrative attributes; it must be a plain login role`,
      );
    }
    await client.query(`grant ${RUNTIME_GROUP_ROLE} to "${user}"`);
  } finally {
    await client.end();
  }
}

/**
 * What is wrong with the role the server is connected as, if anything. An empty list means the
 * runtime role is least-privilege. Production refuses to start otherwise; development warns.
 */
export async function inspectRuntimeRole(
  db: DbExecutor,
): Promise<{ role: string; problems: string[] }> {
  const { rows } = await sql<{
    role: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    ownsObjects: boolean;
    createSchemas: string[] | null;
    createDatabase: boolean;
    inRuntimeGroup: boolean;
  }>`
    select r.rolname as role, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
           exists (
             select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = any(${[...APP_SCHEMAS]}::text[])
               and pg_has_role(current_user, c.relowner, 'USAGE')
           ) as owns_objects,
           (select array_agg(nspname::text order by nspname) from pg_namespace
             where nspname = any(${[...APP_SCHEMAS]}::text[])
               and has_schema_privilege(current_user, oid, 'CREATE')) as create_schemas,
           has_database_privilege(current_user, current_database(), 'CREATE') as create_database,
           pg_has_role(current_user, ${RUNTIME_GROUP_ROLE}, 'MEMBER') as in_runtime_group
    from pg_roles r where r.rolname = current_user`.execute(db);
  const r = rows[0];
  if (!r) return { role: 'unknown', problems: ['current role not found'] };

  const problems: string[] = [];
  if (r.rolsuper) problems.push('is a superuser');
  if (r.rolcreaterole) problems.push('can create roles');
  if (r.rolcreatedb) problems.push('can create databases');
  if (r.rolbypassrls) problems.push('bypasses row-level security');
  if (r.ownsObjects) problems.push('owns (or acts as the owner of) application tables');
  if (r.createSchemas?.length) problems.push(`can create objects in ${r.createSchemas.join(', ')}`);
  if (r.createDatabase) problems.push('can create schemas or extensions in the database');
  if (!r.inRuntimeGroup) problems.push(`is not a member of ${RUNTIME_GROUP_ROLE}`);
  return { role: r.role, problems };
}

/** The newest migration version recorded in the database (null if none). */
export async function appliedSchemaVersion(db: DbExecutor): Promise<string | null> {
  const { rows } = await sql<{
    version: string | null;
  }>`select max(version) as version from system.schema_migrations`.execute(db);
  return rows[0]?.version ?? null;
}

import type { Logger } from '../logger';
import type { DbExecutor } from './database';
import { latestMigrationVersion, migrate } from './migrate';
import { appliedSchemaVersion, ensureRuntimeLogin, inspectRuntimeRole } from './roles';

/** As the OWNER: apply pending migrations, then make sure the runtime login role exists. */
export async function prepareDatabase(args: {
  ownerUrl: string;
  runtimeUrl: string;
  logger?: Pick<Logger, 'info'>;
}): Promise<{ applied: string[] }> {
  const result = await migrate(args.ownerUrl, args.logger ? { logger: args.logger } : {});
  await ensureRuntimeLogin(args.ownerUrl, args.runtimeUrl, args.logger);
  return result;
}

export class DatabaseNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseNotReadyError';
  }
}

/**
 * Startup check on the RUNTIME connection:
 * - the schema must be at this build's migration version (the server never migrates in
 *   production; `pnpm db:migrate` runs as a separate, owner-privileged step);
 * - the role must be least-privilege. Production refuses to start otherwise; development and
 *   test only warn, so a misconfigured local setup is visible but not blocking.
 */
export async function assertDatabaseReady(
  db: DbExecutor,
  opts: { env: string; logger: Pick<Logger, 'warn'> },
): Promise<void> {
  const [applied, expected] = await Promise.all([
    appliedSchemaVersion(db),
    latestMigrationVersion(),
  ]);
  if (applied !== expected) {
    throw new DatabaseNotReadyError(
      `Database schema is at version ${applied ?? 'none'} but this build needs ${expected ?? 'none'}. Run \`pnpm db:migrate\` with DATABASE_OWNER_URL.`,
    );
  }

  const { role, problems } = await inspectRuntimeRole(db);
  if (problems.length === 0) return;
  const message = `Database role "${role}" is not a least-privilege runtime role: ${problems.join('; ')}`;
  if (opts.env === 'production') throw new DatabaseNotReadyError(message);
  opts.logger.warn({ role, problems }, message);
}

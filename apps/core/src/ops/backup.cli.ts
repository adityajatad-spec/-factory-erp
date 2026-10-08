import path from 'node:path';
import { z } from 'zod';
import { createLogger } from '../logger';
import { findRepoPath } from '../platform/paths';
import { createBackup, restoreBackup, verifyBackup } from './backup';

/**
 *   pnpm backup                                   back up the database and blob store
 *   pnpm backup:verify <backup-dir>               restore drill into a throwaway database
 *   pnpm backup:restore <backup-dir> --database <new-name>
 *
 * Runs as the schema OWNER (DATABASE_OWNER_URL). Backups go to BACKUP_DIR (default .backups
 * at the repository root). Paths on the command line are relative to where pnpm was run.
 */
const env = z
  .object({
    DATABASE_OWNER_URL: z.string().regex(/^postgres(ql)?:\/\//),
    DATA_DIR: z.string().default('./.data'),
    BACKUP_DIR: z.string().optional(),
    LOG_LEVEL: z.string().default('info'),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    'Backups run as the schema owner: set DATABASE_OWNER_URL (see .env.example)\n',
  );
  process.exit(1);
}

const logger = createLogger(env.data.LOG_LEVEL, process.stdout.isTTY);
const fromCaller = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
const ownerUrl = env.data.DATABASE_OWNER_URL;
const [command, target] = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

try {
  switch (command) {
    case 'create': {
      const backupRoot = env.data.BACKUP_DIR
        ? fromCaller(env.data.BACKUP_DIR)
        : path.join(path.dirname(findRepoPath('pnpm-workspace.yaml')), '.backups');
      const { dir, manifest } = await createBackup({
        ownerUrl,
        dataDir: path.resolve(env.data.DATA_DIR),
        backupRoot,
        logger,
      });
      logger.info(
        { dir, schema: manifest.schemaVersion, blobs: manifest.blobs.count },
        `backup written — verify it with: pnpm backup:verify "${dir}"`,
      );
      break;
    }
    case 'verify': {
      if (!target) throw new Error('usage: pnpm backup:verify <backup-dir>');
      const { manifest, problems } = await verifyBackup({ dir: fromCaller(target), ownerUrl });
      if (problems.length) {
        logger.error({ problems }, 'backup FAILED verification');
        process.exitCode = 1;
      } else {
        logger.info(
          { createdAt: manifest.createdAt, counts: manifest.counts },
          'backup verified: files intact, restore drill passed, books reconcile',
        );
      }
      break;
    }
    case 'restore': {
      const database = flag('--database');
      if (!target || !database) {
        throw new Error('usage: pnpm backup:restore <backup-dir> --database <new-database-name>');
      }
      const { manifest, blobsCopied } = await restoreBackup({
        dir: fromCaller(target),
        ownerUrl,
        database,
        dataDir: path.resolve(env.data.DATA_DIR),
      });
      logger.info(
        { database, createdAt: manifest.createdAt, blobsCopied },
        `restored and verified — stop the server, point DATABASE_URL and DATABASE_OWNER_URL at "${database}", run pnpm db:migrate, then start it`,
      );
      break;
    }
    default:
      throw new Error(
        'usage: backup.cli.ts create | verify <dir> | restore <dir> --database <name>',
      );
  }
} catch (err) {
  logger.fatal({ err }, 'backup command failed');
  process.exitCode = 1;
}

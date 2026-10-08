import { z } from 'zod';
import { createLogger } from '../logger';
import { prepareDatabase } from './prepare';

/**
 * pnpm db:migrate — run as the schema OWNER (DATABASE_OWNER_URL): apply pending migrations,
 * then make sure the runtime login role in DATABASE_URL exists and belongs to the runtime
 * group. This is the only step that needs owner credentials; the server never does in
 * production.
 */
const env = z
  .object({
    DATABASE_OWNER_URL: z.string().regex(/^postgres(ql)?:\/\//),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
    LOG_LEVEL: z.string().default('info'),
    NODE_ENV: z.string().default('development'),
  })
  .safeParse(process.env);
if (!env.success) {
  const missing = env.error.issues.map((i) => i.path.join('.')).join(', ');
  process.stderr.write(
    `pnpm db:migrate needs DATABASE_OWNER_URL (schema owner) and DATABASE_URL (runtime role); check: ${missing}\n`,
  );
  process.exit(1);
}

const logger = createLogger(env.data.LOG_LEVEL, env.data.NODE_ENV === 'development');
try {
  const { applied } = await prepareDatabase({
    ownerUrl: env.data.DATABASE_OWNER_URL,
    runtimeUrl: env.data.DATABASE_URL,
    logger,
  });
  logger.info(
    { count: applied.length },
    applied.length ? 'migrations complete' : 'database already up to date',
  );
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}

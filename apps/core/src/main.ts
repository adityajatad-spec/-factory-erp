import { loadConfig } from './config';
import { assertDatabaseReady, prepareDatabase } from './db/prepare';
import { buildApp } from './http/app';
import { createLogger } from './logger';
import { createServices } from './services';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development' && process.stdout.isTTY);

// Development convenience: with owner credentials configured (never in production — config
// rejects it), migrate at startup and make sure the runtime login role exists.
if (config.databaseOwnerUrl) {
  await prepareDatabase({
    ownerUrl: config.databaseOwnerUrl,
    runtimeUrl: config.databaseUrl,
    logger,
  });
}

const services = createServices(config, logger);
// The server itself runs as the least-privilege runtime role, on a current schema.
await assertDatabaseReady(services.db, { env: config.env, logger });
const app = await buildApp(services);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await app.close();
  await services.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
services.outbox.start();
logger.info({ env: config.env, web: config.webDistDir ?? null }, 'Factory ERP core started');

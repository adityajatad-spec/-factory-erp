import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { createLogger } from './logger';
import { createServices } from './services';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development' && process.stdout.isTTY);

// Forward-only migrations run at startup (no-op when up to date; transactional per file).
await migrate(config.databaseUrl, { logger });

const services = createServices(config, logger);
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

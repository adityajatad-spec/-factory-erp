import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { migrate } from './migrate';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development');

try {
  const { applied } = await migrate(config.databaseUrl, { logger });
  logger.info(
    { count: applied.length },
    applied.length ? 'migrations complete' : 'database already up to date',
  );
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}

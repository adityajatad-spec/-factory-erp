import { loadConfig } from '../config';
import { migrate } from '../db/migrate';
import { resetDatabase } from '../db/reset';
import { createLogger } from '../logger';
import { createServices } from '../services';
import { seedDemo } from './seed';

/**
 * pnpm db:seed            — migrate, then add demo data if absent
 * pnpm db:seed -- --reset — DEV ONLY: drop everything, migrate, seed afresh
 */
const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development');
const reset = process.argv.includes('--reset');
const password = process.env.DEMO_PASSWORD ?? 'factory-demo';

const services = createServices(config, logger);
try {
  if (reset) {
    await resetDatabase(config.databaseUrl, config.env);
    logger.warn('database reset');
  }
  await migrate(config.databaseUrl, { logger });
  const result = await seedDemo(services, { password });
  if (result.seeded) {
    const pdfs = await services.outbox.runOnce(50);
    logger.info({ pdfJobs: pdfs }, 'processed outbox (invoice and credit-note PDFs)');
    logger.info(
      `Demo users: owner, admin, accountant, production, purchase, hrmanager, supervisor, worker — password "${password}"`,
    );
  }
} catch (err) {
  logger.fatal({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await services.close();
}

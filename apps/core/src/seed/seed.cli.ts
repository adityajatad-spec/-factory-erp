import { loadConfig } from '../config';
import { prepareDatabase } from '../db/prepare';
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

const ownerUrl = config.databaseOwnerUrl;
if (!ownerUrl) {
  logger.fatal('pnpm db:seed needs DATABASE_OWNER_URL (it migrates the schema before seeding)');
  process.exit(1);
}
const services = createServices(config, logger);
try {
  if (reset) {
    await resetDatabase(ownerUrl, config.env);
    logger.warn('database reset');
  }
  await prepareDatabase({ ownerUrl, runtimeUrl: config.databaseUrl, logger });
  const result = await seedDemo(services, { password });
  if (result.seeded) {
    const pdfs = await services.outbox.runOnce(50);
    logger.info({ pdfJobs: pdfs }, 'processed outbox (document PDFs)');
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

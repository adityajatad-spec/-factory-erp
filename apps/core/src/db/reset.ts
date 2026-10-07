import pg from 'pg';

const APP_SCHEMAS = [
  'inventory',
  'docs',
  'finance',
  'sales',
  'catalog',
  'party',
  'audit',
  'identity',
  'platform',
  'system',
];

/**
 * DEVELOPMENT ONLY: drop every application schema (including append-only ledgers) so the
 * database can be rebuilt from migrations. Never callable in production.
 */
export async function resetDatabase(databaseUrl: string, env: string): Promise<void> {
  if (env === 'production') throw new Error('Refusing to reset a production database');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`drop schema if exists ${APP_SCHEMAS.join(', ')} cascade`);
  } finally {
    await client.end();
  }
}

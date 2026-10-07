import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../db/database';
import { APP_VERSION } from '../version';

/** Unauthenticated liveness and database checks. They reveal no data or configuration. */
export function registerHealthRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get('/health', (_req, reply) =>
    reply.send({
      status: 'ok',
      service: 'factory-erp-core',
      version: APP_VERSION,
      time: new Date().toISOString(),
    }),
  );

  app.get('/health/db', async (req, reply) => {
    const started = performance.now();
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      req.log.error({ err }, 'database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}

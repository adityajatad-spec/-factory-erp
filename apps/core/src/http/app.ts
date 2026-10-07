import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import type { Services } from '../services';
import { uuidv7 } from '../platform/ids';
import { registerAuthRoutes, registerSessionHook } from './auth-routes';
import { registerErrorHandling } from './errors';
import './fastify-types';
import { registerHealthRoutes } from './health-routes';
import { registerBusinessRoutes } from './routes';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'",
};

/**
 * The single HTTP application. It serves the API under /api/v1 and, when built, the web app
 * itself (R2-D1): one origin for LAN and remote access.
 */
export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config } = services;
  // Widen pino's Logger to Fastify's logger interface (a plain assignment, no cast).
  const loggerInstance: FastifyBaseLogger = services.logger;
  const app = Fastify({
    loggerInstance,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    },
    bodyLimit: 1_048_576,
    trustProxy: '127.0.0.1',
  });

  // JSON only: removing the text/plain parser closes the "simple request" CSRF route.
  app.removeContentTypeParser('text/plain');
  await app.register(cookie);

  const serveWeb = !!config.webDistDir && existsSync(config.webDistDir);
  if (serveWeb && config.webDistDir) {
    // Files are resolved per request, so a rebuilt web app is served without a restart.
    await app.register(fastifyStatic, { root: config.webDistDir });
  }
  registerErrorHandling(app, { spaFallback: serveWeb });

  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    reply.header('x-request-id', req.id);
  });

  await app.register(
    async (api) => {
      registerHealthRoutes(api, services);
      registerSessionHook(api, services);
      await registerAuthRoutes(api, services);
      registerBusinessRoutes(api, services);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

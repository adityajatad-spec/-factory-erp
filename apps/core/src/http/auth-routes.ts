import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Database } from '../db/database';
import type { AuthService } from '../modules/identity/auth-service';
import { resolveSession, SESSION_COOKIE } from '../modules/identity/sessions';
import type { Clock } from '../platform/clock';
import { requireAuthenticated } from '../platform/commands';

/** Resolve the session cookie on every /api request into `request.actor`. */
export function registerSessionHook(
  app: FastifyInstance,
  deps: { db: Database; clock: Clock },
): void {
  app.decorateRequest('actor', null as unknown as FastifyRequest['actor']);
  app.addHook('onRequest', async (req) => {
    req.actor = { requestId: req.id, user: null, actorKind: 'user' };
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = await resolveSession(deps.db, token, deps.clock.now());
    if (user) req.actor = { requestId: req.id, user, actorKind: 'user' };
  });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; config: Config },
): Promise<void> {
  const cookieOptions = {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    // Lax: the cookie is not sent on cross-site POSTs, which (with JSON-only bodies)
    // protects state-changing requests from CSRF.
    sameSite: 'lax' as const,
    path: '/',
  };

  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: 10, timeWindow: '1 minute' });
    scope.post('/auth/login', async (req, reply) => {
      const { token, expiresAt, user } = await deps.auth.login(req.body, {
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
      return user;
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const actor = requireAuthenticated(req.actor);
    await deps.auth.logout(actor);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (req) => {
    const actor = requireAuthenticated(req.actor);
    return deps.auth.sessionUser(actor.user.id, actor.user.companyId);
  });
}

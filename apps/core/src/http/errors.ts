import { ERROR_CODES, type ProblemDetails } from '@factory-erp/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../platform/errors';

function problem(
  status: number,
  code: string,
  title: string,
  extra: Partial<ProblemDetails> = {},
): ProblemDetails {
  return { type: 'about:blank', title, status, code, ...extra };
}

/**
 * Every error leaves the API as RFC 9457 problem+json with a stable machine code.
 * With `spaFallback`, unknown non-API GETs serve the web app's index.html instead (client-side
 * routes such as /sales/invoices); unknown API routes always get a JSON 404.
 */
export function registerErrorHandling(
  app: FastifyInstance,
  opts: { spaFallback?: boolean } = {},
): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    let body: ProblemDetails;
    if (err instanceof AppError) {
      body = problem(err.httpStatus, err.code, err.message, {
        requestId: req.id,
        ...(err.issues ? { issues: [...err.issues] } : {}),
        ...('rule' in err && typeof err.rule === 'string' ? { detail: err.rule } : {}),
      });
    } else if (
      'statusCode' in err &&
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      // Framework-level client errors (bad JSON, unsupported media type, rate limit, ...).
      body = problem(
        err.statusCode,
        err.statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
        err.message,
        { requestId: req.id },
      );
    } else {
      req.log.error({ err }, 'unhandled error');
      body = problem(
        500,
        ERROR_CODES.internal,
        'Something went wrong. The error has been logged.',
        { requestId: req.id },
      );
    }
    void reply.code(body.status).type('application/problem+json').send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    // Client-side routes get index.html; a missing *file* (e.g. a stale /assets/x.js) stays a 404.
    if (
      opts.spaFallback &&
      req.method === 'GET' &&
      !path.startsWith('/api/') &&
      !/\.[a-z0-9]+$/i.test(path)
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .type('application/problem+json')
      .send(
        problem(
          404,
          ERROR_CODES.notFound,
          `No route for ${req.method} ${req.url.split('?')[0] ?? ''}`,
          { requestId: req.id },
        ),
      );
  });
}

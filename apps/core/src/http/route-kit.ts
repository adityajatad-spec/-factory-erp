import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { CommandBus, CommandDefinition } from '../platform/commands';
import { ValidationError } from '../platform/errors';
import type { QueryBus, QueryDefinition } from '../platform/queries';

const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** Every command request must carry an Idempotency-Key (retries, double clicks, offline replay). */
export function requireIdempotencyKey(req: FastifyRequest): string {
  const value = req.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || !KEY.test(key)) {
    throw new ValidationError([
      { path: 'Idempotency-Key', message: 'Header is required (8–200 safe characters)' },
    ]);
  }
  return key;
}

/** Fastify leaves params/query untyped; the command/query schemas validate them. */
export const params = (req: FastifyRequest) =>
  (req.params ?? {}) as Record<string, string | undefined>;
export const queryString = (req: FastifyRequest) =>
  (req.query ?? {}) as Record<string, string | undefined>;
export const body = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

/** Thin adapter: HTTP request → command bus. No business logic lives in routes. */
export function commandRoute<S extends z.ZodType, R>(
  bus: CommandBus,
  command: CommandDefinition<S, R>,
  toInput: (req: FastifyRequest) => unknown,
  successStatus = 200,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<R> => {
    const result = await bus.execute(command, toInput(req), req.actor, {
      idempotencyKey: requireIdempotencyKey(req),
    });
    reply.code(successStatus);
    return result;
  };
}

/** Thin adapter: HTTP request → query bus. */
export function queryRoute<S extends z.ZodType, R>(
  bus: QueryBus,
  query: QueryDefinition<S, R>,
  toInput: (req: FastifyRequest) => unknown = () => ({}),
) {
  return async (req: FastifyRequest): Promise<R> => bus.execute(query, toInput(req), req.actor);
}

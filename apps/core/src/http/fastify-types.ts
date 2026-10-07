import type { Actor } from '../platform/actor';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for every /api request by the session hook; `user` is null when signed out. */
    actor: Actor;
  }
}

export {};

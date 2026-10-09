import {
  CopilotTurnRequest,
  ERROR_CODES,
  PERMISSIONS,
  type CopilotTurnResponse,
} from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import type { Copilot, CopilotFailure } from '../ai/copilot';
import { resolveCompanyPolicy } from '../ai/policy-resolver';
import type { AiPolicyStatus, AiService, AiStatus } from '../ai/service';
import { setAiPolicy, viewAiPolicy } from '../modules/copilot';
import type { CommandBus } from '../platform/commands';
import type { QueryBus } from '../platform/queries';
import type { RateLimiter } from '../platform/rate-limiter';
import { requireAuthenticated } from '../platform/commands';
import {
  AppError,
  ForbiddenError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
  ValidationError,
} from '../platform/errors';
import { zodIssues } from '../platform/validation';
import { body, commandRoute, queryRoute } from './route-kit';

/**
 * AI availability as any signed-in user sees it: the state, the provider and its locality, a
 * coded reason, and the company policy's state. Never the model identifier (deployment
 * detail; the owner sees approved models in the policy view), internal URLs or error text.
 */
export type AiStatusResponse = Omit<AiStatus, 'modelId'>;

/**
 * AI availability for signed-in users (the copilot UI needs it). Reports the actual state —
 * disabled, unavailable (with a coded reason) or reachable — and never internal URLs or error
 * text. The check is bounded by AI_HEALTH_TIMEOUT_MS and cached briefly by the gateway.
 */
export function registerAiRoutes(
  app: FastifyInstance,
  deps: {
    ai: AiService;
    commands: CommandBus;
    queries: QueryBus;
    copilot: Copilot;
    copilotRateLimiter: RateLimiter;
  },
): void {
  app.get('/ai/status', async (req): Promise<AiStatusResponse> => {
    const actor = requireAuthenticated(req.actor);
    // Same gates as the buses, before anything is contacted.
    if (actor.user.mustChangePassword) throw new PasswordChangeRequiredError();
    if (!actor.user.permissions.has(PERMISSIONS.companyRead)) {
      throw new ForbiddenError(PERMISSIONS.companyRead);
    }
    const status = await deps.ai.check();
    const r = await resolveCompanyPolicy(deps.queries, actor);
    const policy: AiPolicyStatus = r.ok
      ? { state: r.policy.aiEnabled ? 'ENABLED' : 'DISABLED', version: r.policy.version }
      : {
          state:
            r.reason === 'POLICY_MISSING'
              ? 'NONE'
              : r.reason === 'POLICY_UNAVAILABLE'
                ? 'UNAVAILABLE'
                : 'INVALID',
          version: null,
        };
    // Field by field, so nothing added to the internal status is published by accident.
    return {
      state: status.state,
      providerId: status.providerId,
      locality: status.locality,
      reason: status.reason,
      checkedAt: status.checkedAt,
      policy,
    };
  });

  // The company AI policy: a minimal view for any signed-in user (detail only for the owner);
  // changed only by the owner (the command enforces both the permission and the OWNER role).
  // The full stored policy (ai.policy.get) is server-side only.
  app.get('/ai/policy', queryRoute(deps.queries, viewAiPolicy));
  app.put('/ai/policy', commandRoute(deps.commands, setAiPolicy, body));

  /**
   * One copilot turn. A thin adapter over `copilot.answer` — the only model execution path —
   * which re-checks session, person, permissions and the company policy throughout the turn.
   * The route adds what only HTTP knows: the session's actor, early refusals (signed out,
   * password change pending, no company access, malformed body) before any AI work, the
   * per-person turn budget, and cancellation when the client goes away.
   */
  app.post(
    '/ai/copilot/turns',
    { bodyLimit: COPILOT_BODY_LIMIT },
    async (req, reply): Promise<CopilotTurnResponse> => {
      const actor = requireAuthenticated(req.actor);
      if (actor.user.mustChangePassword) throw new PasswordChangeRequiredError();
      if (!actor.user.permissions.has(PERMISSIONS.companyRead)) {
        throw new ForbiddenError(PERMISSIONS.companyRead);
      }
      // The copilot validates again; this only gives the client the usual 400 with issues.
      const parsed = CopilotTurnRequest.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(zodIssues(parsed.error));

      // Per-person turn budget, keyed only by the SESSION's company and user (never the body),
      // after every cheap refusal above so that a rejected request costs nothing. Per process.
      const admission = deps.copilotRateLimiter.take(`${actor.user.companyId}:${actor.user.id}`);
      if (!admission.ok) {
        req.log.info(
          { userId: actor.user.id, companyId: actor.user.companyId },
          'copilot turn rate limited',
        );
        reply.header('retry-after', String(Math.ceil(admission.retryAfterMs / 1000)));
        throw rateLimited();
      }

      // The client hanging up cancels the turn. 'close' also fires after a normal response,
      // hence the writableEnded check; the listener is removed whatever happens.
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', onClose);
      try {
        const r = await deps.copilot.answer(actor, req.body, { signal: controller.signal });
        if (!r.ok) {
          if (r.reason === 'BUSY') {
            // Nothing ran: a turn refused for concurrency does not use up the budget.
            admission.release();
            reply.header('retry-after', String(COPILOT_RETRY_AFTER_S));
          }
          throw copilotError(r.reason);
        }
        // Local inference only; anything else is refused, never returned.
        if (r.servedBy.locality !== 'LOCAL') throw copilotError('AI_UNAVAILABLE');
        const used = r.toolCalls.filter((c) => c.outcome === 'OK' || c.outcome === 'TRUNCATED');
        return {
          answer: r.answer,
          locality: 'LOCAL',
          toolsUsed: [...new Set(used.flatMap((c) => (c.tool ? [c.tool] : [])))],
          truncated: used.some((c) => c.outcome === 'TRUNCATED'),
        };
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    },
  );
}

/** A question is at most 2000 characters; anything near this size is not a copilot request. */
const COPILOT_BODY_LIMIT = 16_384;
const COPILOT_RETRY_AFTER_S = 5;

/**
 * The HTTP contract for a turn that did not answer: fixed codes and fixed text. Never the
 * provider's or the database's own message, a model name, SQL, or a stack.
 */
const COPILOT_ERRORS: Record<CopilotFailure, () => AppError> = {
  INVALID_REQUEST: () =>
    new ValidationError([{ path: '', message: 'The request is not a valid copilot question' }]),
  // The session, the account or the password state stopped being valid during the turn.
  NOT_AUTHORIZED: () => new UnauthenticatedError(),
  AUTHORIZATION_CHANGED: () =>
    new AppError(
      ERROR_CODES.aiAuthorizationChanged,
      409,
      'Your access or the AI policy changed while the assistant was working. Please ask again.',
    ),
  AI_DISABLED: () =>
    new AppError(ERROR_CODES.aiDisabled, 503, 'The AI assistant is not set up on this server.'),
  BUSY: () =>
    new AppError(
      ERROR_CODES.aiBusy,
      429,
      'The AI assistant is busy. Please try again in a few seconds.',
    ),
  POLICY_BLOCKED: () =>
    new AppError(
      ERROR_CODES.aiPolicyBlocked,
      403,
      "The company's AI policy does not allow this request.",
    ),
  POLICY_UNAVAILABLE: () => unavailable(),
  AI_UNAVAILABLE: () => unavailable(),
  MODEL_ERROR: () => unavailable(),
  TIMEOUT: () => timedOut(),
  TURN_TIMEOUT: () => timedOut(),
  TOOL_TIMEOUT: () => timedOut(),
  CANCELLED: () => new AppError(ERROR_CODES.requestCancelled, 499, 'The request was cancelled.'),
  NO_ANSWER: () => noAnswer(),
  TURN_LIMIT: () => noAnswer(),
  FAILED: () => new AppError(ERROR_CODES.internal, 500, 'Something went wrong. Please try again.'),
};
const rateLimited = () =>
  new AppError(
    ERROR_CODES.aiRateLimited,
    429,
    'You have asked the AI assistant many questions in a short time. Please wait before asking again.',
  );
const unavailable = () =>
  new AppError(ERROR_CODES.aiUnavailable, 503, 'The AI assistant is unavailable right now.');
const timedOut = () =>
  new AppError(ERROR_CODES.aiTimeout, 504, 'The AI assistant took too long to answer.');
const noAnswer = () =>
  new AppError(
    ERROR_CODES.aiNoAnswer,
    422,
    'The AI assistant could not produce an answer. Try rephrasing the question.',
  );

export function copilotError(reason: CopilotFailure): AppError {
  return COPILOT_ERRORS[reason]();
}

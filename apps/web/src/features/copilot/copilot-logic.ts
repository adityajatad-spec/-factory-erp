import {
  COPILOT_MAX_QUESTION_CHARS,
  COPILOT_TOOLS,
  withinDataClass,
  type AiPolicyViewDto,
  type AiStatusDto,
  type CopilotToolName,
  type DataClass,
} from '@factory-erp/contracts';
import { ApiError } from '../../lib/api';

/**
 * What the copilot page shows, derived from server responses only. Pure functions: the page
 * renders them, unit tests pin them. Nothing here grants anything — the server decides.
 */

// --- AI readiness (GET /ai/status) ---------------------------------------------------------------

export type ReadinessKind = 'checking' | 'ready' | 'off' | 'unavailable' | 'unknown';

export interface Readiness {
  kind: ReadinessKind;
  /** Short label for the status indicator. */
  label: string;
  /** One or two sentences: what it means for the person. Null when there is nothing to add. */
  detail: string | null;
  /** False when asking is pointless until someone changes the setup. */
  canAsk: boolean;
}

const RUNTIME_REASONS: Record<NonNullable<AiStatusDto['reason']>, string> = {
  UNREACHABLE: 'The local AI runtime on the server is not responding.',
  UNEXPECTED_RESPONSE: 'The local AI runtime on the server answered in an unexpected way.',
  MODEL_NOT_INSTALLED: 'The AI model configured for this server is not installed.',
  MODEL_NOT_LOCAL:
    'The configured AI model would run on an outside service, so it is refused: answers are only produced on this server.',
};

export function aiReadiness(status: AiStatusDto | undefined, failed = false): Readiness {
  if (!status) {
    return failed
      ? {
          kind: 'unknown',
          label: 'AI status unknown',
          detail: 'The AI status could not be checked. You can still ask; the server decides.',
          canAsk: true,
        }
      : { kind: 'checking', label: 'Checking AI…', detail: null, canAsk: true };
  }
  if (status.state === 'DISABLED') {
    return {
      kind: 'off',
      label: 'AI not set up',
      detail: 'The AI assistant is not set up on this server.',
      canAsk: false,
    };
  }
  switch (status.policy.state) {
    case 'NONE':
    case 'DISABLED':
      return {
        kind: 'off',
        label: 'Off for this company',
        detail:
          "Your company's AI policy has the assistant switched off. The company owner decides whether to turn it on.",
        canAsk: false,
      };
    case 'INVALID':
      return {
        kind: 'off',
        label: 'AI policy unusable',
        detail: "Your company's AI policy could not be used, so the assistant stays off.",
        canAsk: false,
      };
    case 'UNAVAILABLE':
      return {
        kind: 'unavailable',
        label: 'AI policy not checked',
        detail: "Your company's AI policy could not be read just now. Try again shortly.",
        canAsk: true,
      };
    default:
      break;
  }
  if (status.locality !== null && status.locality !== 'LOCAL') {
    return {
      kind: 'unavailable',
      label: 'AI unavailable',
      detail: 'Only AI running on this server is allowed.',
      canAsk: false,
    };
  }
  if (status.state === 'UNAVAILABLE') {
    const reason = status.reason ?? 'UNREACHABLE';
    return {
      kind: 'unavailable',
      label: 'Local AI unavailable',
      detail: RUNTIME_REASONS[reason],
      // A missing or non-local model needs someone to change the server; a pause does not.
      canAsk: reason === 'UNREACHABLE' || reason === 'UNEXPECTED_RESPONSE',
    };
  }
  if (status.state === 'NOT_CHECKED') {
    return { kind: 'checking', label: 'Checking AI…', detail: null, canAsk: true };
  }
  return { kind: 'ready', label: 'Local AI ready', detail: null, canAsk: true };
}

// --- Lookups and suggested questions ---------------------------------------------------------------

const SUGGESTIONS: Record<CopilotToolName, string> = {
  'parties.list': 'Which customers and suppliers do we have?',
  'finance.receivables.summary': 'Which customers owe us money, and how much is overdue?',
  'finance.payables.summary': 'How much do we owe each supplier, and what is due this week?',
  'inventory.stock.list': 'What stock do we have on hand, by warehouse?',
  'inventory.warehouses.list': 'Which warehouses do we have?',
};

/** Where a person can check a lookup's figures in the ERP itself. */
export const LOOKUP_PAGES: Record<
  CopilotToolName,
  '/sales/customers' | '/finance/receivables' | '/finance/payables' | '/inventory/stock'
> = {
  'parties.list': '/sales/customers',
  'finance.receivables.summary': '/finance/receivables',
  'finance.payables.summary': '/finance/payables',
  'inventory.stock.list': '/inventory/stock',
  'inventory.warehouses.list': '/inventory/stock',
};

/** The data ceiling the company's policy sets for copilot answers (null: not known). */
export function copilotCeiling(policy: AiPolicyViewDto | null | undefined): DataClass | null {
  return policy?.tasks.find((t) => t.task === 'copilot.answer')?.maxDataClass ?? null;
}

/**
 * The lookups this person could get answered: their own permissions and, when known, the
 * company policy's data ceiling — the same two filters the server applies.
 */
export function availableLookups(
  permissions: readonly string[],
  ceiling: DataClass | null,
): (typeof COPILOT_TOOLS)[number][] {
  return COPILOT_TOOLS.filter(
    (t) =>
      permissions.includes(t.permission) &&
      (ceiling === null || withinDataClass(t.dataClass, ceiling)),
  );
}

export function suggestedQuestions(
  permissions: readonly string[],
  ceiling: DataClass | null,
): string[] {
  return availableLookups(permissions, ceiling).map((t) => SUGGESTIONS[t.name]);
}

/** Labels for the lookups an answer used; names the client does not know are kept, plainly. */
export function lookupLabels(
  toolsUsed: readonly string[],
): { name: string; label: string; page: (typeof LOOKUP_PAGES)[CopilotToolName] | null }[] {
  return toolsUsed.map((name) => {
    const tool = COPILOT_TOOLS.find((t) => t.name === name);
    return tool
      ? { name, label: tool.label, page: LOOKUP_PAGES[tool.name] }
      : { name, label: name, page: null };
  });
}

// --- Failures ---------------------------------------------------------------------------------------

export interface CopilotNotice {
  /** Stable code (the server's, or CANCELLED / NETWORK / UNKNOWN). */
  code: string;
  tone: 'neutral' | 'amber' | 'red';
  title: string;
  body: string;
  /** Asking the same question again may work. */
  canRetry: boolean;
  /** The AI status or the person's access may have changed: refresh them. */
  refresh: boolean;
}

/** "about 45 seconds", "about 3 minutes". */
export function formatWait(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return `about ${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.ceil(seconds / 60);
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}

const isAbort = (err: unknown) =>
  (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

export function describeCopilotError(err: unknown): CopilotNotice {
  if (isAbort(err)) {
    return {
      code: 'CANCELLED',
      tone: 'neutral',
      title: 'Cancelled',
      body: 'You cancelled this question. No answer was shown.',
      canRetry: true,
      refresh: false,
    };
  }
  if (!(err instanceof ApiError)) {
    return {
      code: 'NETWORK',
      tone: 'red',
      title: 'Could not reach the server',
      body: 'Check the connection to the ERP server and try again.',
      canRetry: true,
      refresh: false,
    };
  }
  const wait = err.retryAfterSeconds;
  const n = (
    tone: CopilotNotice['tone'],
    title: string,
    body: string,
    canRetry: boolean,
    refresh = false,
  ): CopilotNotice => ({ code: err.code, tone, title, body, canRetry, refresh });

  switch (err.code) {
    case 'UNAUTHENTICATED':
      return n(
        'amber',
        'Your session has ended',
        'Sign in again to keep using the assistant.',
        false,
      );
    case 'PASSWORD_CHANGE_REQUIRED':
      return n(
        'amber',
        'Choose a new password first',
        'Your administrator set a temporary password.',
        false,
      );
    case 'FORBIDDEN':
      return n(
        'red',
        'Not available for your role',
        'Your role cannot use the AI assistant.',
        false,
      );
    case 'VALIDATION_FAILED':
      return n(
        'amber',
        'This question cannot be sent',
        `A question must be between 1 and ${COPILOT_MAX_QUESTION_CHARS} characters.`,
        false,
      );
    case 'AI_DISABLED':
      return n(
        'neutral',
        'AI is not set up',
        'The AI assistant is not set up on this server.',
        false,
        true,
      );
    case 'AI_POLICY_BLOCKED':
      return n(
        'neutral',
        "Not allowed by your company's AI policy",
        "The company's AI policy does not allow this request. The company owner decides the AI policy.",
        false,
        true,
      );
    case 'AI_UNAVAILABLE':
      return n(
        'amber',
        'The AI assistant is unavailable',
        'The local AI is not responding right now. Try again in a moment.',
        true,
        true,
      );
    case 'AI_TIMEOUT':
      return n(
        'amber',
        'The assistant took too long',
        'It stopped before finishing. Try again, or ask a narrower question.',
        true,
      );
    case 'AI_BUSY':
      return n(
        'amber',
        'The assistant is busy',
        `It is answering other questions. Try again in ${formatWait(wait ?? 5)}.`,
        true,
      );
    case 'AI_RATE_LIMITED':
      return n(
        'amber',
        'Too many questions for now',
        `You have asked many questions in a short time. You can ask again in ${formatWait(wait ?? 60)}.`,
        true,
      );
    case 'AI_NO_ANSWER':
      return n(
        'amber',
        'No answer this time',
        'The assistant could not produce an answer. Try rephrasing the question.',
        true,
      );
    case 'AI_AUTHORIZATION_CHANGED':
      return n(
        'amber',
        'Your access changed',
        'Your access or the company AI policy changed while the assistant was working, so the answer was withheld. Please ask again.',
        true,
        true,
      );
    case 'REQUEST_CANCELLED':
      return n('neutral', 'Cancelled', 'The request was cancelled.', true);
    case 'DATABASE_UNAVAILABLE':
    case 'QUERY_TIMEOUT':
      return n('amber', 'The system is busy', 'Please try again in a moment.', true);
    default:
      return n(
        'red',
        'Something went wrong',
        err.requestId
          ? `The error has been logged (reference ${err.requestId}). Please try again.`
          : 'Please try again.',
        true,
      );
  }
}

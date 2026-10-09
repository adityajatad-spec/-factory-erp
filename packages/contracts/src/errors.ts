/** RFC 9457 problem details, as returned by every failed API request. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  /** Stable machine-readable code, e.g. "VERSION_CONFLICT". */
  code: string;
  detail?: string;
  requestId?: string;
  issues?: Array<{ path: string; message: string }>;
}

export const ERROR_CODES = {
  validationFailed: 'VALIDATION_FAILED',
  unauthenticated: 'UNAUTHENTICATED',
  invalidCredentials: 'INVALID_CREDENTIALS',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  versionConflict: 'VERSION_CONFLICT',
  duplicate: 'DUPLICATE',
  idempotencyKeyReused: 'IDEMPOTENCY_KEY_REUSED',
  businessRule: 'BUSINESS_RULE_VIOLATION',
  passwordChangeRequired: 'PASSWORD_CHANGE_REQUIRED',
  tooManyAttempts: 'TOO_MANY_ATTEMPTS',
  queryTimeout: 'QUERY_TIMEOUT',
  databaseUnavailable: 'DATABASE_UNAVAILABLE',
  // The AI copilot (POST /ai/copilot/turns). Codes only: never provider or database text.
  aiDisabled: 'AI_DISABLED',
  aiPolicyBlocked: 'AI_POLICY_BLOCKED',
  aiUnavailable: 'AI_UNAVAILABLE',
  aiBusy: 'AI_BUSY',
  aiRateLimited: 'AI_RATE_LIMITED',
  aiTimeout: 'AI_TIMEOUT',
  aiNoAnswer: 'AI_NO_ANSWER',
  aiAuthorizationChanged: 'AI_AUTHORIZATION_CHANGED',
  requestCancelled: 'REQUEST_CANCELLED',
  internal: 'INTERNAL_ERROR',
} as const;

import { ERROR_CODES } from '@factory-erp/contracts';

export interface ErrorIssue {
  path: string;
  message: string;
}

/** Base class for errors that are safe to show to API clients. */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly issues: readonly ErrorIssue[] | undefined;

  constructor(code: string, httpStatus: number, message: string, issues?: readonly ErrorIssue[]) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.issues = issues;
  }
}

export class ValidationError extends AppError {
  constructor(issues: readonly ErrorIssue[], message = 'The request is invalid') {
    super(ERROR_CODES.validationFailed, 400, message, issues);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Sign in to continue') {
    super(ERROR_CODES.unauthenticated, 401, message);
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(ERROR_CODES.invalidCredentials, 401, 'Incorrect username or password');
  }
}

export class ForbiddenError extends AppError {
  constructor(permission: string) {
    super(
      ERROR_CODES.forbidden,
      403,
      `You do not have permission to perform this action (${permission})`,
    );
  }
}

/** The user must replace an administrator-set password before doing anything else. */
export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super(
      ERROR_CODES.passwordChangeRequired,
      403,
      'Choose a new password to continue (your administrator set a temporary one)',
    );
  }
}

/** A read ran past its statement time limit; PostgreSQL cancelled the statement. */
export class QueryTimeoutError extends AppError {
  constructor() {
    super(ERROR_CODES.queryTimeout, 503, 'The request took too long. Please try again.');
  }
}

/** No database connection could be had in time (the pool's bounded acquisition wait). */
export class DatabaseUnavailableError extends AppError {
  constructor(options?: { cause?: unknown }) {
    super(
      ERROR_CODES.databaseUnavailable,
      503,
      'The system is busy right now. Please try again in a moment.',
    );
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/** Sign-in backoff after repeated failures for one username. */
export class TooManyAttemptsError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      ERROR_CODES.tooManyAttempts,
      429,
      `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(ERROR_CODES.notFound, 404, `${entity} not found`);
  }
}

export class VersionConflictError extends AppError {
  constructor(entity: string) {
    super(
      ERROR_CODES.versionConflict,
      409,
      `${entity} was changed by someone else. Reload and try again.`,
    );
  }
}

export class DuplicateError extends AppError {
  constructor(message: string) {
    super(ERROR_CODES.duplicate, 409, message);
  }
}

export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.idempotencyKeyReused,
      422,
      'This Idempotency-Key was already used for a different request',
    );
  }
}

/** A business rule rejected the operation. `rule` is a stable code for clients and AI tools. */
export class BusinessRuleError extends AppError {
  readonly rule: string;

  constructor(rule: string, message: string, issues?: readonly ErrorIssue[]) {
    super(ERROR_CODES.businessRule, 422, message, issues);
    this.rule = rule;
  }
}

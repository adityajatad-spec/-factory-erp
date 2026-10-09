import { AppError } from './errors';

/** An error raised by PostgreSQL (node-postgres `DatabaseError`): it has a SQLSTATE and a severity. */
export interface PgError extends Error {
  code: string;
  severity: string;
  constraint?: string;
  table?: string;
  column?: string;
  schema?: string;
  dataType?: string;
  routine?: string;
}

export function isPgError(err: unknown): err is PgError {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    'severity' in err
  );
}

/**
 * The SQLSTATE and where it happened. Never `message` (may quote values), `detail` (row
 * values), `where` / `internalQuery` (SQL text), `hint`, or the constraint's name.
 */
const PG_LOG_FIELDS = [
  'code',
  'severity',
  'table',
  'column',
  'schema',
  'dataType',
  'routine',
] as const;

const MAX_CAUSE_DEPTH = 3;

function className(err: Error): string {
  const name = err.constructor.name;
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Error';
}

/**
 * The `err` log serializer. A PostgreSQL error — also one wrapped as another error's `cause` —
 * is reduced to its SQLSTATE, table and column: its message and `detail` can carry row values
 * ("Failing row contains (...)"), and `where` / `internalQuery` carry SQL text. Other errors keep their message and stack (code-authored), but
 * not arbitrary enumerable properties, which may hold request or client configuration.
 */
export function serializeErrorForLog(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const type = className(err);
  if (isPgError(err)) {
    const out: Record<string, unknown> = { type };
    for (const f of PG_LOG_FIELDS) if (typeof err[f] === 'string') out[f] = err[f];
    return out;
  }
  const out: Record<string, unknown> = { type, message: err.message, stack: err.stack };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  if (err instanceof AppError) out.httpStatus = err.httpStatus;
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeErrorForLog(err.cause, depth + 1);
  }
  return out;
}

/**
 * The reason recorded on a failed background job, which company administrators see. Only an
 * AppError's message is written for clients; anything else becomes its class and stable code
 * (SQLSTATE or Node system code), with the details left to the server log.
 */
export function publicJobError(err: unknown): string {
  if (err instanceof AppError) return err.message.slice(0, 2000);
  if (!(err instanceof Error)) return 'The job failed. Details are in the server log.';
  const code = (err as { code?: unknown }).code;
  const suffix = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` ${code}` : '';
  return `The job failed (${className(err)}${suffix}). Details are in the server log.`;
}

import type { ProblemDetails } from '@factory-erp/contracts';

/** An API failure carrying the server's RFC 9457 problem details. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ProblemDetails['issues'];
  readonly requestId: string | undefined;
  readonly rule: string | undefined;
  /** The server's Retry-After (seconds), when it sent one with a 429 or 503. */
  readonly retryAfterSeconds: number | undefined;

  constructor(problem: ProblemDetails, retryAfterSeconds?: number) {
    super(problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.issues = problem.issues;
    this.requestId = problem.requestId;
    this.rule = problem.detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Retry-After in delta-seconds (the only form the server sends); anything else is ignored. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function isProblem(v: unknown): v is ProblemDetails {
  return !!v && typeof v === 'object' && 'status' in v && 'code' in v && 'title' in v;
}

/** Random key per user action. Works without a secure context (unlike crypto.randomUUID). */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type Query = Record<string, string | number | boolean | undefined | null>;

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = newIdempotencyKey();

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    throw new ApiError(
      isProblem(data)
        ? data
        : {
            type: 'about:blank',
            title: res.statusText || 'Request failed',
            status: res.status,
            code: `HTTP_${res.status}`,
          },
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, query ? { query } : {}),
  post: <T>(path: string, body?: unknown, opts: { signal?: AbortSignal } = {}) =>
    request<T>('POST', path, { body: body ?? {}, ...opts }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, query ? { query } : {}),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const first = err.issues?.[0];
    return first ? `${err.message}: ${first.path} — ${first.message}` : err.message;
  }
  return err instanceof Error ? err.message : 'Unexpected error';
}

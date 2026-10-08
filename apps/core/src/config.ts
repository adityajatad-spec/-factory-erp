import path from 'node:path';
import { z } from 'zod';

const PostgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: PostgresUrl,
    /** Schema owner. Development only: lets the server migrate at startup. */
    DATABASE_OWNER_URL: PostgresUrl.optional(),
    DATA_DIR: z.string().min(1).default('./.data'),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    PDF_BROWSER_EXECUTABLE: z.string().min(1).optional(),
    WEB_DIST_DIR: z.string().min(1).optional(),
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    /** Sign-in requests per minute from one IP (per-username backoff applies on top). */
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.DATABASE_OWNER_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_OWNER_URL'],
        message:
          'must not be set for the server in production (run `pnpm db:migrate` as a separate step; the server holds only runtime credentials)',
      });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production (sessions must only travel over HTTPS)',
      });
    }
  });

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databaseOwnerUrl: string | undefined;
  dataDir: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  pdfBrowserExecutable: string | undefined;
  webDistDir: string | undefined;
  outboxPollMs: number;
  loginRateLimitPerMinute: number;
}

export class ConfigError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validate the environment once at startup and fail fast with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Messages name the variable and the rule, never the (possibly secret) value.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseOwnerUrl: e.DATABASE_OWNER_URL,
    dataDir: path.resolve(e.DATA_DIR),
    cookieSecure: e.COOKIE_SECURE,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    pdfBrowserExecutable: e.PDF_BROWSER_EXECUTABLE,
    webDistDir: e.WEB_DIST_DIR ? path.resolve(e.WEB_DIST_DIR) : undefined,
    outboxPollMs: e.OUTBOX_POLL_MS,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
  };
}

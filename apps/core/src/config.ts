import path from 'node:path';
import { z } from 'zod';

const PostgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');

/** An http(s) base URL without credentials (the local AI runtime needs none). */
const ServiceUrl = z
  .string()
  .trim()
  .min(1)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'must be an http:// or https:// URL without credentials');

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
    /** Longest wait for a pooled database connection before a request fails with 503. */
    DATABASE_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
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
    /**
     * Copilot turns one person may start per window (POST /ai/copilot/turns), on top of the
     * concurrency limits. Counted per server process — not a distributed limit.
     */
    COPILOT_RATE_LIMIT_TURNS: z.coerce.number().int().min(1).max(1000).default(20),
    COPILOT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(86_400).default(600),
    /**
     * Local AI runtime. "none" (the default) switches AI off; "fake" is a deterministic test
     * provider (never in production). There is no cloud provider.
     */
    AI_PROVIDER: z.enum(['none', 'ollama', 'fake']).default('none'),
    OLLAMA_URL: ServiceUrl.default('http://127.0.0.1:11434'),
    /** The installed local model to use, e.g. "qwen2.5:7b". Never downloaded automatically. */
    AI_MODEL: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, 'must be an Ollama model name like qwen2.5:7b')
      // Ollama "cloud" models run on a remote service: never allowed (local inference only).
      .refine((m) => !/[:-]cloud$/i.test(m), 'cloud models are not allowed (local inference only)')
      .optional(),
    AI_MODEL_CONTEXT_TOKENS: z.coerce.number().int().min(1024).max(1_000_000).default(8192),
    /** Hard limit for one model call. */
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),
    /** Hard limit for one availability check. */
    AI_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2000),
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
    if (env.AI_PROVIDER === 'ollama' && !env.AI_MODEL) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_MODEL'],
        message: 'is required when AI_PROVIDER is ollama (name an installed local model)',
      });
    }
    if (env.NODE_ENV === 'production' && env.AI_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message: 'fake is for tests and development only',
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
  databasePoolAcquireTimeoutMs: number;
  dataDir: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  pdfBrowserExecutable: string | undefined;
  webDistDir: string | undefined;
  outboxPollMs: number;
  loginRateLimitPerMinute: number;
  /** Per person, per server process (see platform/rate-limiter.ts). */
  copilotRateLimit: { turns: number; windowMs: number };
  ai: AiConfig;
}

/** The copilot's per-person turn budget unless configured otherwise: 20 turns per 10 minutes. */
export const COPILOT_RATE_LIMIT_DEFAULT = { turns: 20, windowMs: 600_000 } as const;

/** Local AI runtime settings. Operational only: they never widen the AI data policy. */
export interface AiConfig {
  provider: 'none' | 'ollama' | 'fake';
  ollamaUrl: string;
  model: string | null;
  contextTokens: number;
  timeoutMs: number;
  healthTimeoutMs: number;
}

/** AI off: what tests and a fresh installation get. */
export const AI_DISABLED: AiConfig = {
  provider: 'none',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: null,
  contextTokens: 8192,
  timeoutMs: 120_000,
  healthTimeoutMs: 2000,
};

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
  // The fake AI provider must be asked for in an environment that is EXPLICITLY development or
  // test: an unset NODE_ENV (which defaults to development) is not enough.
  if (e.AI_PROVIDER === 'fake' && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new ConfigError([
      'AI_PROVIDER: fake requires NODE_ENV to be set explicitly to development or test',
    ]);
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseOwnerUrl: e.DATABASE_OWNER_URL,
    databasePoolAcquireTimeoutMs: e.DATABASE_POOL_ACQUIRE_TIMEOUT_MS,
    dataDir: path.resolve(e.DATA_DIR),
    cookieSecure: e.COOKIE_SECURE,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    pdfBrowserExecutable: e.PDF_BROWSER_EXECUTABLE,
    webDistDir: e.WEB_DIST_DIR ? path.resolve(e.WEB_DIST_DIR) : undefined,
    outboxPollMs: e.OUTBOX_POLL_MS,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    copilotRateLimit: {
      turns: e.COPILOT_RATE_LIMIT_TURNS,
      windowMs: e.COPILOT_RATE_LIMIT_WINDOW_SECONDS * 1000,
    },
    ai: {
      provider: e.AI_PROVIDER,
      ollamaUrl: e.OLLAMA_URL,
      model: e.AI_MODEL ?? null,
      contextTokens: e.AI_MODEL_CONTEXT_TOKENS,
      timeoutMs: e.AI_TIMEOUT_MS,
      healthTimeoutMs: e.AI_HEALTH_TIMEOUT_MS,
    },
  };
}

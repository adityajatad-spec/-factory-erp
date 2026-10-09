import { pino, type LoggerOptions, type Logger } from 'pino';
import { serializeErrorForLog } from './platform/safe-errors';

/** Fields that must never reach logs. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  '*.currentPassword',
  '*.newPassword',
  '*.initialPassword',
  '*.temporaryPassword',
  // RESTRICTED bank data (supplier bank details).
  'accountNumber',
  '*.accountNumber',
  '*.*.accountNumber',
];

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    // `{ err }` never writes PostgreSQL detail (row values), SQL text or arbitrary error fields.
    serializers: { err: serializeErrorForLog },
    base: { service: 'factory-erp-core' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  };
}

export function createLogger(level: string, pretty = false): Logger {
  return pino(loggerOptions(level, pretty));
}

export type { Logger };

import type { z } from 'zod';
import type { ErrorIssue } from './errors';

export function zodIssues(error: z.ZodError): ErrorIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

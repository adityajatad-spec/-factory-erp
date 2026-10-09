import { z } from 'zod';

/** Longest question the copilot accepts (characters). */
export const COPILOT_MAX_QUESTION_CHARS = 2000;

/**
 * One copilot turn as a client may request it: the question, nothing else. Strict: who asks, for
 * which company and with which permissions always come from the server-side session — a request
 * naming a company, user, role, permission, data class or actor is refused, not ignored.
 */
export const CopilotTurnRequest = z
  .object({
    question: z.string().trim().min(1).max(COPILOT_MAX_QUESTION_CHARS),
  })
  .strict();
export type CopilotTurnRequest = z.input<typeof CopilotTurnRequest>;

/**
 * A copilot answer. Deliberately small: the text, where it ran, and which ERP lookups it used
 * (registered read-only query names). No model name, prompt, tool arguments or raw results.
 */
export interface CopilotTurnResponse {
  answer: string;
  locality: 'LOCAL';
  toolsUsed: string[];
  /** True when a lookup returned more rows than the model was shown. */
  truncated: boolean;
}

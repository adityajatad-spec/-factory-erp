import { z } from 'zod';
import type { DataClass } from './data-class';
import { PERMISSIONS, type Permission } from './permissions';

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

/**
 * GET /api/v1/ai/status as any signed-in user sees it. No model identifier, URL or error text:
 * the state, the provider's id and locality, a coded reason, and the company policy's state.
 */
export interface AiStatusDto {
  state: 'DISABLED' | 'NOT_CHECKED' | 'REACHABLE' | 'UNAVAILABLE';
  providerId: string | null;
  locality: 'LOCAL' | 'CLOUD' | null;
  /** Why it is unavailable, as a code. */
  reason: 'UNREACHABLE' | 'MODEL_NOT_INSTALLED' | 'UNEXPECTED_RESPONSE' | 'MODEL_NOT_LOCAL' | null;
  checkedAt: string | null;
  policy: {
    state: 'NOT_RESOLVED' | 'NONE' | 'INVALID' | 'UNAVAILABLE' | 'DISABLED' | 'ENABLED';
    version: number | null;
  };
}

/**
 * The read-only ERP lookups the copilot may use, as people see them. The server's tool
 * catalogue is the authority (a core test keeps this list identical to it); clients use it only
 * to label `toolsUsed` and to suggest questions the signed-in person could actually get answered.
 */
export const COPILOT_TOOLS = [
  {
    name: 'parties.list',
    label: 'Customers and suppliers',
    permission: PERMISSIONS.partyRead,
    dataClass: 'CONFIDENTIAL',
  },
  {
    name: 'finance.receivables.summary',
    label: 'Receivables summary',
    permission: PERMISSIONS.receivablesRead,
    dataClass: 'CONFIDENTIAL',
  },
  {
    name: 'finance.payables.summary',
    label: 'Payables summary',
    permission: PERMISSIONS.payablesRead,
    dataClass: 'CONFIDENTIAL',
  },
  {
    name: 'inventory.stock.list',
    label: 'Stock on hand',
    permission: PERMISSIONS.inventoryStockRead,
    dataClass: 'INTERNAL',
  },
  {
    name: 'inventory.warehouses.list',
    label: 'Warehouses',
    permission: PERMISSIONS.inventoryStockRead,
    dataClass: 'INTERNAL',
  },
] as const satisfies ReadonlyArray<{
  name: string;
  label: string;
  permission: Permission;
  dataClass: DataClass;
}>;
export type CopilotToolName = (typeof COPILOT_TOOLS)[number]['name'];

import {
  ProviderError,
  type AbortSignalLike,
  type Message,
  type ModelInfo,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ToolCall,
} from '@factory-erp/ai';
import { z } from 'zod';

/**
 * Local inference through Ollama's HTTP API (`/api/chat`, `/api/tags`). Everything provider
 * specific stays in this file. The HTTP client is injected, so tests never need a daemon, and
 * errors carry no prompt text.
 */

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OllamaConfig {
  baseUrl: string;
  /** The models this installation offers to the gateway (from validated configuration). */
  models: readonly ModelInfo[];
  fetch?: FetchLike;
  healthTimeoutMs?: number;
}

const ChatResponse = z.object({
  message: z.object({
    role: z.string(),
    content: z.string().default(''),
    tool_calls: z
      .array(
        z.object({
          function: z.object({ name: z.string(), arguments: z.unknown() }),
        }),
      )
      .optional(),
  }),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

const TagsResponse = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      // Present on models the runtime forwards to a remote service (Ollama cloud models).
      remote_host: z.string().optional(),
      remote_model: z.string().optional(),
    }),
  ),
});
type InstalledModel = z.infer<typeof TagsResponse>['models'][number];

/**
 * Ollama can list "cloud" models that it forwards to a remote host. They are not local
 * inference, so they are never used, whatever the configuration or the policy says.
 */
export function isRemoteOllamaModel(m: InstalledModel): boolean {
  return m.remote_host !== undefined || m.remote_model !== undefined || /[:-]cloud$/i.test(m.name);
}

function toWire(m: Message) {
  const content = m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  return {
    role: m.role,
    content,
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
    ...(m.role === 'tool' && m.toolName ? { tool_name: m.toolName } : {}),
  };
}

export function ollamaAdapter(cfg: OllamaConfig): ProviderAdapter {
  const http: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, init));
  const base = cfg.baseUrl.replace(/\/+$/, '');

  async function call(path: string, body: unknown, signal?: AbortSignal) {
    let res;
    try {
      res = await http(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'Request aborted');
      throw new ProviderError(
        'UNAVAILABLE',
        `Local AI runtime not reachable at ${base} (${e instanceof Error ? e.name : 'error'})`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 && /not found/i.test(text)) {
        throw new ProviderError('MODEL_NOT_FOUND', 'The configured model is not installed locally');
      }
      if (res.status === 400 && /does not support tools/i.test(text)) {
        throw new ProviderError('NOT_SUPPORTED', 'The configured model does not support tools');
      }
      throw new ProviderError('UNAVAILABLE', `Local AI runtime answered HTTP ${res.status}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError('MALFORMED_RESPONSE', 'Local AI runtime returned invalid JSON');
    }
  }

  return {
    id: 'ollama',
    locality: 'LOCAL',
    listModels: () => Promise.resolve([...cfg.models]),

    async health() {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), cfg.healthTimeoutMs ?? 2000);
      try {
        const tags = TagsResponse.safeParse(await call('/api/tags', undefined, controller.signal));
        if (!tags.success) return { ok: false, detail: 'UNEXPECTED_RESPONSE' };
        const installed = new Map(tags.data.models.map((m) => [m.name, m]));
        const entries = cfg.models.map((m) => installed.get(m.id.replace(/^ollama:/, '')));
        if (entries.some((e) => !e)) return { ok: false, detail: 'MODEL_NOT_INSTALLED' };
        if (entries.some((e) => e && isRemoteOllamaModel(e))) {
          return { ok: false, detail: 'MODEL_NOT_LOCAL' };
        }
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          detail:
            e instanceof ProviderError && e.kind === 'MALFORMED_RESPONSE'
              ? 'UNEXPECTED_RESPONSE'
              : 'UNREACHABLE',
        };
      } finally {
        clearTimeout(t);
      }
    },

    async invoke(
      model: string,
      req: NormalizedRequest,
      signal: AbortSignalLike,
    ): Promise<NormalizedResponse> {
      if (req.capability === 'embed' || req.capability === 'vision') {
        throw new ProviderError('NOT_SUPPORTED', `${req.capability} is not wired for Ollama yet`);
      }
      // Before any company data is sent: the model must be installed AND run on this machine.
      // (Checked on every call — a model can be re-pulled as a cloud model at any time.)
      const name = model.replace(/^ollama:/, '');
      const tags = TagsResponse.safeParse(
        await call('/api/tags', undefined, signal as AbortSignal),
      );
      if (!tags.success) {
        throw new ProviderError('MALFORMED_RESPONSE', 'Unexpected /api/tags response shape');
      }
      const entry = tags.data.models.find((m) => m.name === name);
      if (!entry) {
        throw new ProviderError('MODEL_NOT_FOUND', 'The configured model is not installed locally');
      }
      if (isRemoteOllamaModel(entry)) {
        throw new ProviderError('NOT_SUPPORTED', 'The configured model is not a local model');
      }
      const raw = await call(
        '/api/chat',
        {
          model: name,
          stream: false,
          messages: req.messages.map(toWire),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          ...(req.outputSchema ? { format: req.outputSchema } : {}),
          options: {
            temperature: 0,
            ...(req.maxOutputTokens ? { num_predict: req.maxOutputTokens } : {}),
          },
        },
        signal as AbortSignal,
      );
      const parsed = ChatResponse.safeParse(raw);
      if (!parsed.success) {
        throw new ProviderError('MALFORMED_RESPONSE', 'Unexpected /api/chat response shape');
      }
      const toolCalls: ToolCall[] = (parsed.data.message.tool_calls ?? []).map((c, i) => ({
        id: `call_${i + 1}`,
        name: c.function.name,
        // Some runtimes send arguments as a JSON string; the server validates them anyway.
        arguments:
          typeof c.function.arguments === 'string'
            ? safeJson(c.function.arguments)
            : c.function.arguments,
      }));
      return {
        text: parsed.data.message.content,
        toolCalls,
        // Usage only when the runtime reports it; never estimated here.
        inputTokens: parsed.data.prompt_eval_count ?? null,
        outputTokens: parsed.data.eval_count ?? null,
      };
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

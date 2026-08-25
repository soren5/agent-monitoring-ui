import { archiveProviderExchange } from './exchange-archive.js';
import { registerProvider } from './provider-registry.js';
import { callRegisteredTool, registeredTools } from '../mcp-tools/server.js';
import { touchHeartbeat } from '../db/connection.js';
import '../mcp-tools/core.js';
import '../mcp-tools/interactive.js';
import '../mcp-tools/agents.js';
import '../mcp-tools/factory.js';
import '../mcp-tools/repository.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

// The host injects this fixed, non-secret endpoint only for this provider.
// Keep the model list narrow: embedding models cannot produce chat completions,
// and agents cannot redirect requests to arbitrary hosts.
const BASE_URL = 'http://local-model.bridge:1234/v1';
const ALLOWED_MODELS = new Set(['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b']);
// Verified as loadable on this install; the larger Qwen model remains
// allowlisted but requires the owner to make sufficient LM Studio resources
// available before selecting it for an agent.
const DEFAULT_MODEL = 'google/gemma-4-12b-qat';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly model: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model || DEFAULT_MODEL;
    if (!ALLOWED_MODELS.has(this.model)) {
      throw new Error(`Local model is not approved: ${this.model}. Allowed: ${[...ALLOWED_MODELS].join(', ')}`);
    }
  }

  registerMemorySessionHook(): void {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({ provider: 'openai-compatible', ...exchange });
  }

  query(input: QueryInput): AgentQuery {
    const model = this.model;
    const pending = [input.prompt];
    const history: ChatMessage[] = input.systemContext?.instructions
      ? [{ role: 'system', content: input.systemContext.instructions }]
      : [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let controller: AbortController | null = null;
    const continuation = input.continuation || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        const provenance = { provider: 'openai-compatible', model, sessionId: continuation };
        yield { type: 'init', continuation };
        yield { type: 'capability', reasoning: 'none', toolProgress: true, provenance };
        yield { type: 'status', status: 'starting', activity: 'OpenAI-compatible session initialized', provenance };
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted || (ended && pending.length === 0)) return;
          const prompt = pending.shift();
          if (!prompt) continue;
          history.push({ role: 'user', content: prompt });
          controller = new AbortController();
          // Local models are slow (~8-10 tok/s). Give a single generation a
          // generous 10-minute budget so it isn't aborted by the runtime's
          // default fetch timeout mid-reply; the host sweep still enforces the
          // absolute stuck ceiling, so a truly hung request is still reaped.
          const fetchTimeout = setTimeout(() => controller?.abort(), 10 * 60_000);
          // Keep the container alive while the model is generating: the host
          // sweep's claim-stuck rule treats silence past ~60s as dead, but a
          // local-model call takes minutes. Touch the heartbeat every 20s so
          // the sweep sees fresh liveness until the fetch resolves.
          const heartbeatKeeper = setInterval(() => touchHeartbeat(), 20_000);
          try {
            yield { type: 'activity', label: 'OpenAI-compatible generation', status: 'in_progress', provenance };
            yield { type: 'status', status: 'in_progress', activity: 'Generating response', provenance };
            const tools = registeredTools().map((entry) => ({
              type: 'function',
              function: {
                name: entry.tool.name,
                description: entry.tool.description,
                parameters: entry.tool.inputSchema,
              },
            }));
            // Bound the generation: local models (gemma-4-12b-qat) run at
            // ~8-10 tok/s, so an unconstrained completion can run for many
            // minutes and trip the runtime's fetch timeout. A generous cap
            // keeps replies complete while preventing a runaway generation.
            const response = await fetch(`${BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model,
                messages: history,
                tools,
                tool_choice: 'auto',
                stream: false,
                max_tokens: 2048,
              }),
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(`Local model request failed: HTTP ${response.status} ${await response.text()}`);
            const body = (await response.json()) as {
              choices?: Array<{
                message?: {
                  content?: unknown;
                  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
                };
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const message = body.choices?.[0]?.message;
            const calls = message?.tool_calls ?? [];
            if (calls.length > 0) {
              history.push({
                role: 'assistant',
                content: typeof message?.content === 'string' ? message.content : '',
                tool_calls: calls,
              });
              for (const [callIndex, call] of calls.slice(0, 8).entries()) {
                const name = call.function?.name ?? '';
                const toolCallId = call.id || `${continuation}:tool:${history.length}:${callIndex}`;
                const safeName = redactOpenAiCompatibleTelemetry(name).slice(0, 120) || 'tool';
                yield {
                  type: 'tool',
                  phase: 'start',
                  name: safeName,
                  toolCallId,
                  provenance: { ...provenance, itemId: toolCallId },
                };
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
                } catch {
                  /* tool gets a bounded invalid-arguments response */
                }
                try {
                  const result = await callRegisteredTool(name, args);
                  history.push({
                    role: 'tool',
                    tool_call_id: toolCallId,
                    content: result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n'),
                  });
                  yield {
                    type: 'tool',
                    phase: 'complete',
                    name: safeName,
                    toolCallId,
                    detail: { status: 'completed' },
                    provenance: { ...provenance, itemId: toolCallId },
                  };
                } catch (toolError) {
                  const message = toolError instanceof Error ? toolError.message : String(toolError);
                  history.push({ role: 'tool', tool_call_id: toolCallId, content: `Tool failed: ${message}` });
                  yield {
                    type: 'tool',
                    phase: 'complete',
                    name: safeName,
                    toolCallId,
                    detail: { status: 'failed', error: redactOpenAiCompatibleTelemetry(message) },
                    provenance: { ...provenance, itemId: toolCallId },
                  };
                }
              }
              pending.unshift('Continue using the tool results above; do not repeat completed calls.');
              continue;
            }
            const text = message?.content;
            if (typeof text !== 'string')
              throw new Error('Local model response did not contain choices[0].message.content');
            history.push({ role: 'assistant', content: text });
            if (body.usage) {
              const promptTokens = safeTokenCount(body.usage.prompt_tokens);
              const completionTokens = safeTokenCount(body.usage.completion_tokens);
              yield {
                type: 'usage',
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: safeTokenCount(body.usage.total_tokens) || promptTokens + completionTokens,
                },
              };
            }
            yield {
              type: 'output',
              text: redactOpenAiCompatibleTelemetry(text),
              format: 'markdown',
              partial: false,
              provenance,
            };
            yield { type: 'status', status: 'idle', activity: 'Response completed', provenance };
            yield { type: 'result', text };
          } catch (err) {
            if (aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            yield {
              type: 'error',
              message: redactOpenAiCompatibleTelemetry(message),
              retryable: true,
              classification: classifyOpenAiCompatibleError(message),
              provenance,
            };
            yield { type: 'status', status: 'failed', activity: 'OpenAI-compatible request failed', provenance };
          } finally {
            clearTimeout(fetchTimeout);
            clearInterval(heartbeatKeeper);
            controller = null;
          }
        }
      },
    };

    return {
      push(message) {
        pending.push(message);
        wake();
      },
      end() {
        ended = true;
        wake();
      },
      events,
      abort() {
        aborted = true;
        controller?.abort();
        wake();
      },
    };
  }
}

function safeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function classifyOpenAiCompatibleError(message: string): string | undefined {
  if (/billing|credit|quota/i.test(message)) return 'quota';
  if (/auth|api.?key|credential|unauthorized/i.test(message)) return 'auth';
  if (/rate.?limit|timeout|temporar/i.test(message)) return 'rate_limit';
  return undefined;
}

export function redactOpenAiCompatibleTelemetry(text: string): string {
  return text
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 2_000);
}

registerProvider('openai-compatible', (options) => new OpenAiCompatibleProvider(options));

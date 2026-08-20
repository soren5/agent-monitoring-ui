import { spawnSync } from 'child_process';

import { registerProvider } from './provider-registry.js';
import { archiveProviderExchange } from './exchange-archive.js';
import { callRegisteredTool, registeredTools } from '../mcp-tools/server.js';
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
  ProviderUsage,
  QueryInput,
} from './types.js';

// DeepSeek's OpenAI-compatible endpoint, injected by the host (see
// src/providers/deepseek.ts). Fixed and non-secret. Requests ride the OneCLI
// gateway proxy, which swaps in the real credential at request time.
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
// Host-owned deterministic model allowlist. The group's container config
// `model` is validated against this before any request is made.
const ALLOWED_MODELS = new Set(['deepseek-v4-flash']);
const DEFAULT_MODEL = 'deepseek-v4-flash';

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: unknown[] };

/** Structural mirror of the shared memory hook registration (memory/session-hook.ts). */
interface DeepSeekMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

const MEMORY_TIMEOUT_MS = 10_000;

export function runDeepSeekMemoryHook(hook: DeepSeekMemorySessionHook | undefined, source: string): string | undefined {
  if (!hook) return undefined;
  if (!hook.sources.includes(source as never)) return undefined;
  try {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
      encoding: 'utf-8',
      timeout: MEMORY_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) return undefined;
    const out = (res.stdout ?? '').trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export class DeepSeekProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly model: string;
  private memorySessionHook?: DeepSeekMemorySessionHook;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model === undefined ? DEFAULT_MODEL : options.model;
    if (!ALLOWED_MODELS.has(this.model)) {
      throw new Error(`DeepSeek model is not approved: ${this.model}. Allowed: ${[...ALLOWED_MODELS].join(', ')}`);
    }
  }

  registerMemorySessionHook(hook: DeepSeekMemorySessionHook): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({ provider: 'deepseek', ...exchange });
  }

  query(input: QueryInput): AgentQuery {
    const model = this.model;
    const pending: Array<{ text: string }> = [{ text: input.prompt }];
    // Memory joins a brand-new context only — a resumed conversation already
    // carries it, exactly like the shared session-hook lifecycle.
    const memory = input.continuation ? undefined : runDeepSeekMemoryHook(this.memorySessionHook, 'startup');
    const systemInstructions = memory
      ? `${memory}\n\n${input.systemContext?.instructions ?? ''}`.trim()
      : input.systemContext?.instructions;
    const history: ChatMessage[] = systemInstructions
      ? [{ role: 'system', content: systemInstructions }]
      : [];
    // Per-turn usage accumulator, reset on each query(). Summed across every
    // chat-completions round of the turn (tool calls included), then emitted
    // as one aggregated `usage` event right before the result.
    let turnUsage: ProviderUsage | undefined;
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let controller: AbortController | null = null;
    const continuation = input.continuation || `deepseek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation };
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted || (ended && pending.length === 0)) return;
          const prompt = pending.shift();
          if (!prompt) continue;
          history.push({ role: 'user', content: prompt.text });
          controller = new AbortController();
          try {
            yield { type: 'activity' };
            const tools = registeredTools().map((entry) => ({
              type: 'function',
              function: { name: entry.tool.name, description: entry.tool.description, parameters: entry.tool.inputSchema },
            }));
            const response = await fetch(`${BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, messages: history, tools, tool_choice: 'auto', stream: false }),
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`DeepSeek request failed: HTTP ${response.status} ${await response.text()}`);
            const body = (await response.json()) as {
              choices?: Array<{
                message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
              };
            };
            // In-band usage: accumulate across the turn's rounds so one
            // aggregated event covers the whole turn, tool calls included.
            const usage = body.usage;
            if (usage && typeof usage.total_tokens === 'number') {
              turnUsage = {
                promptTokens: (turnUsage?.promptTokens ?? 0) + (usage.prompt_tokens ?? 0),
                completionTokens: (turnUsage?.completionTokens ?? 0) + (usage.completion_tokens ?? 0),
                reasoningTokens:
                  (turnUsage?.reasoningTokens ?? 0) + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
                totalTokens: (turnUsage?.totalTokens ?? 0) + usage.total_tokens,
              };
            }
            const message = body.choices?.[0]?.message;
            const calls = message?.tool_calls ?? [];
            if (calls.length > 0) {
              history.push({
                role: 'assistant',
                content: typeof message?.content === 'string' ? message.content : '',
                tool_calls: calls,
              });
              for (const call of calls.slice(0, 8)) {
                const name = call.function?.name ?? '';
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
                } catch {
                  /* tool gets a bounded invalid-arguments response */
                }
                const result = await callRegisteredTool(name, args);
                history.push({
                  role: 'tool',
                  tool_call_id: call.id ?? name,
                  content: result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n'),
                });
              }
              pending.unshift({ text: 'Continue using the tool results above; do not repeat completed calls.' });
              continue;
            }
            const text = message?.content;
            if (typeof text !== 'string') throw new Error('DeepSeek response did not contain choices[0].message.content');
            history.push({ role: 'assistant', content: text });
            if (turnUsage) yield { type: 'usage', usage: turnUsage };
            yield { type: 'result', text };
            turnUsage = undefined;
          } catch (err) {
            if (aborted) return;
            yield { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true };
          } finally {
            controller = null;
          }
        }
      },
    };

    return {
      push(message) {
        pending.push({ text: message });
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

registerProvider('deepseek', (options) => new DeepSeekProvider(options));

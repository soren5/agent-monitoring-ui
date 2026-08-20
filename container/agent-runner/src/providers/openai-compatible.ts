import { archiveProviderExchange } from './exchange-archive.js';
import { registerProvider } from './provider-registry.js';
import { callRegisteredTool, registeredTools } from '../mcp-tools/server.js';
import '../mcp-tools/core.js';
import '../mcp-tools/interactive.js';
import '../mcp-tools/agents.js';
import '../mcp-tools/factory.js';
import '../mcp-tools/repository.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange, ProviderOptions, QueryInput } from './types.js';

// The host injects this fixed, non-secret endpoint only for this provider.
// Keep the model list narrow: embedding models cannot produce chat completions,
// and agents cannot redirect requests to arbitrary hosts.
const BASE_URL = 'http://local-model.bridge:1234/v1';
const ALLOWED_MODELS = new Set(['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b']);
// Verified as loadable on this install; the larger Qwen model remains
// allowlisted but requires the owner to make sufficient LM Studio resources
// available before selecting it for an agent.
const DEFAULT_MODEL = 'google/gemma-4-12b-qat';

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: unknown[] };

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
          history.push({ role: 'user', content: prompt });
          controller = new AbortController();
          try {
            yield { type: 'activity' };
            const tools = registeredTools().map((entry) => ({ type: 'function', function: { name: entry.tool.name, description: entry.tool.description, parameters: entry.tool.inputSchema } }));
            const response = await fetch(`${BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, messages: history, tools, tool_choice: 'auto', stream: false }),
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Local model request failed: HTTP ${response.status} ${await response.text()}`);
            const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
            const message = body.choices?.[0]?.message;
            const calls = message?.tool_calls ?? [];
            if (calls.length > 0) {
              history.push({ role: 'assistant', content: typeof message?.content === 'string' ? message.content : '', tool_calls: calls });
              for (const call of calls.slice(0, 8)) {
                const name = call.function?.name ?? '';
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>; } catch { /* tool gets a bounded invalid-arguments response */ }
                const result = await callRegisteredTool(name, args);
                history.push({ role: 'tool', tool_call_id: call.id ?? name, content: result.content.map((item) => item.type === 'text' ? item.text : '').join('\n') });
              }
              pending.unshift('Continue using the tool results above; do not repeat completed calls.');
              continue;
            }
            const text = message?.content;
            if (typeof text !== 'string') throw new Error('Local model response did not contain choices[0].message.content');
            history.push({ role: 'assistant', content: text });
            yield { type: 'result', text };
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

registerProvider('openai-compatible', (options) => new OpenAiCompatibleProvider(options));

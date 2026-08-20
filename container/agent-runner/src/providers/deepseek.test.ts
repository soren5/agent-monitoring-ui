/**
 * Container-side tests for the native deepseek provider.
 *
 * Guards the barrel registration AND the provider behavior: the deterministic
 * model allowlist is host-owned, so a group config pointing at a non-approved
 * model must fail at construction. The provider speaks OpenAI-compatible chat
 * completions against the fixed endpoint injected by the host.
 */
import { describe, expect, it } from 'bun:test';

import { DeepSeekProvider } from './deepseek.js';
import { listProviderNames } from './provider-registry.js';
import './index.js';

describe('deepseek provider', () => {
  it('registers via the container provider barrel', () => {
    expect(listProviderNames()).toContain('deepseek');
  });

  it('accepts only the approved model allowlist', () => {
    expect(() => new DeepSeekProvider({ model: 'deepseek-v4-flash' })).not.toThrow();
    expect(() => new DeepSeekProvider({ model: 'deepseek-chat' })).toThrow(/not approved/);
    expect(() => new DeepSeekProvider({ model: '' })).toThrow(/not approved/);
  });

  it('defaults to the approved model when none is supplied', () => {
    const provider = new DeepSeekProvider();
    const query = provider.query({ prompt: 'hello', cwd: '/tmp', continuation: 'deepseek-test' });
    query.end();
    expect(query.events).toBeDefined();
  });

  it('does not advertise native slash commands', () => {
    expect(new DeepSeekProvider().supportsNativeSlashCommands).toBe(false);
  });

  it('emits one aggregated usage event before the result, summed across tool rounds', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        // Tool-call round: returns a tool_call and usage.
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'noop_tool', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              completion_tokens_details: { reasoning_tokens: 40 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Final round: the answer + more usage.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done', role: 'assistant' } }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 60,
            total_tokens: 260,
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const provider = new DeepSeekProvider({ model: 'deepseek-v4-flash' });
      const query = provider.query({ prompt: 'hello', cwd: '/tmp', continuation: 'deepseek-usage-test' });
      query.end();

      const events: unknown[] = [];
      for await (const event of query.events) events.push(event);

      const usageEvents = events.filter((e) => (e as { type?: string }).type === 'usage');
      expect(usageEvents).toHaveLength(1);
      const usage = (usageEvents[0] as { usage: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number } }).usage;
      expect(usage.totalTokens).toBe(150 + 260);
      expect(usage.promptTokens).toBe(100 + 200);
      expect(usage.completionTokens).toBe(50 + 60);
      expect(usage.reasoningTokens).toBe(40 + 10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

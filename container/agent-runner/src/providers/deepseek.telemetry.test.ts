import { afterEach, describe, expect, it } from 'bun:test';

import { DeepSeekProvider, redactDeepSeekTelemetry } from './deepseek.js';
import type { ProviderEvent } from './types.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function collect(body: unknown, status = 200): Promise<ProviderEvent[]> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const query = new DeepSeekProvider({ model: 'deepseek-v4-flash' }).query({
    prompt: 'hello',
    cwd: '/tmp',
    continuation: 'deepseek-fixture',
  });
  query.end();
  const events: ProviderEvent[] = [];
  for await (const event of query.events) events.push(event);
  return events;
}

describe('DeepSeek normalized telemetry', () => {
  it('maps production success, usage and reasoning-token activity without fabricating text', async () => {
    const events = await collect({
      id: 'ignored-new-field',
      choices: [{ message: { role: 'assistant', content: 'final answer token=visible-to-user' } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 5, future_field: 1 },
      },
      future_field: { accepted: true },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability',
        reasoning: 'unknown',
        provenance: { provider: 'deepseek', model: 'deepseek-v4-flash', sessionId: 'deepseek-fixture' },
      }),
    );
    const reasoning = events.find((event) => event.type === 'reasoning');
    expect(reasoning).toEqual(expect.objectContaining({ type: 'reasoning', availability: 'activity_only' }));
    expect(reasoning).not.toHaveProperty('text');
    expect(events).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 12, completionTokens: 8, reasoningTokens: 5, totalTokens: 20 },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'output', text: 'final answer token=[REDACTED]' }));
    // User delivery remains the exact provider response; redaction is telemetry-only.
    expect(events).toContainEqual({ type: 'result', text: 'final answer token=visible-to-user' });
  });

  it('keeps reasoning unknown when the response exposes no reasoning signal or tools', async () => {
    const events = await collect({ choices: [{ message: { content: 'plain' } }] });
    expect(events.some((event) => event.type === 'reasoning')).toBe(false);
    expect(events.some((event) => event.type === 'tool')).toBe(false);
    expect(events).toContainEqual({ type: 'result', text: 'plain' });
  });

  it('maps and redacts structured request errors', async () => {
    const events = await collect({ error: 'api_key=super-secret Bearer abc.def' }, 401);
    const error = events.find((event) => event.type === 'error');
    expect(error).toEqual(expect.objectContaining({ type: 'error', classification: 'auth', retryable: true }));
    expect(JSON.stringify(error)).not.toContain('super-secret');
    expect(JSON.stringify(error)).not.toContain('abc.def');
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'failed' }));
  });

  it('uses a stable fallback ID and reports tool failure without arguments or results', async () => {
    let round = 0;
    globalThis.fetch = (async () => {
      round += 1;
      const body =
        round === 1
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        function: {
                          name: 'send_message',
                          arguments: '{"password":"do-not-emit"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ message: { content: 'after tool' } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const query = new DeepSeekProvider().query({
      prompt: 'hello',
      cwd: '/tmp',
      continuation: 'missing-id',
    });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    const tools = events.filter((event) => event.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual(
      expect.objectContaining({
        phase: 'start',
        toolCallId: 'missing-id:tool:2:0',
        name: 'send_message',
      }),
    );
    expect(tools[1]).toEqual(
      expect.objectContaining({
        phase: 'complete',
        toolCallId: 'missing-id:tool:2:0',
        detail: { status: 'failed', error: expect.any(String) },
      }),
    );
    expect(JSON.stringify(tools)).not.toContain('do-not-emit');
    expect(JSON.stringify(tools)).not.toContain('to is required');
    expect(events).toContainEqual({ type: 'result', text: 'after tool' });
  });

  it('bounds and redacts telemetry strings', () => {
    const redacted = redactDeepSeekTelemetry(`password=hunter2 ${'x'.repeat(3_000)}`);
    expect(redacted).not.toContain('hunter2');
    expect(redacted.length).toBe(2_000);
  });
});

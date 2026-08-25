import { afterEach, describe, expect, it } from 'bun:test';
import { OpenAiCompatibleProvider, redactOpenAiCompatibleTelemetry } from './openai-compatible.js';
import type { ProviderEvent } from './types.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenAI-compatible telemetry translation', () => {
  it('reports unavailable reasoning, provenance, usage and unchanged final output', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'api_key=abc final output' } }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ model: 'google/gemma-4-12b-qat' });
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.some((event) => event.type === 'capability' && event.reasoning === 'none')).toBe(true);
    expect(events.some((event) => event.type === 'output' && event.text === 'api_key=[REDACTED] final output')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'usage' && event.usage.totalTokens === 11)).toBe(true);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'api_key=abc final output' },
    ]);
    expect(
      events.some(
        (event) =>
          'provenance' in event &&
          event.provenance?.provider === 'openai-compatible' &&
          event.provenance.model === 'google/gemma-4-12b-qat',
      ),
    ).toBe(true);
  });

  it('emits redacted structured request errors', async () => {
    globalThis.fetch = (async () => new Response('api_key=abc unauthorized', { status: 401 })) as typeof fetch;
    const provider = new OpenAiCompatibleProvider();
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      retryable: true,
      classification: 'auth',
      message: 'Local model request failed: HTTP 401 api_key=[REDACTED] unauthorized',
    });
    expect(events.some((event) => event.type === 'status' && event.status === 'failed')).toBe(true);
    expect(redactOpenAiCompatibleTelemetry('Bearer abc.def')).toBe('Bearer [REDACTED]');
  });
});

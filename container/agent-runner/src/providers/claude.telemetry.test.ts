import { describe, expect, it, mock } from 'bun:test';
import type { ProviderEvent } from './types.js';

let queryFixtures: unknown[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const fixture of queryFixtures) yield fixture;
    },
  }),
}));

const { ClaudeProvider, createClaudeTelemetryState, redactClaudeTelemetry, translateClaudeTelemetryMessage } =
  await import('./claude.js');

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

describe('Claude production telemetry translation', () => {
  it('orders streaming output, multiple/nested tools, completion, reasoning and provenance', () => {
    const state = createClaudeTelemetryState('claude-sonnet-4-6', 'high');
    const fixtures = [
      { type: 'system', subtype: 'init', session_id: 'session-1', uuid: 'init-1' },
      {
        type: 'stream_event',
        session_id: 'session-1',
        uuid: 'stream-1',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: 'secret=abc inspect' },
        },
      },
      {
        type: 'stream_event',
        session_id: 'session-1',
        uuid: 'stream-2',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'api_key=abc partial ' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-1',
        uuid: 'stream-3',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { password: 'must-not-leak' } },
        },
      },
      {
        type: 'stream_event',
        session_id: 'session-1',
        uuid: 'stream-4',
        parent_tool_use_id: 'tool-1',
        event: {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/secret' } },
        },
      },
      {
        type: 'tool_progress',
        session_id: 'session-1',
        uuid: 'progress-1',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        elapsed_time_seconds: 2,
      },
      {
        type: 'user',
        session_id: 'session-1',
        uuid: 'result-1',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'Bearer raw-secret' },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
          ],
        },
      },
      { type: 'future_event', session_id: 'session-1', uuid: 'unknown-1', arbitrary: { token: 'must-not-leak' } },
    ];
    const events = fixtures.flatMap((fixture) => translateClaudeTelemetryMessage(fixture, state));
    const normalized = events.filter((event) => ['reasoning', 'output', 'tool'].includes(event.type));
    expect(
      normalized.map((event) => (event.type === 'tool' ? `tool.${event.phase}:${event.toolCallId}` : event.type)),
    ).toEqual([
      'reasoning',
      'output',
      'tool.start:tool-1',
      'tool.start:tool-2',
      'tool.progress:tool-1',
      'tool.complete:tool-2',
      'tool.complete:tool-1',
    ]);
    const nested = events.find((event) => event.type === 'tool' && event.toolCallId === 'tool-2');
    expect(nested).toMatchObject({ detail: { parentToolCallId: 'tool-1' } });
    const failed = events.find(
      (event) => event.type === 'tool' && event.phase === 'complete' && event.toolCallId === 'tool-2',
    );
    expect(failed).toMatchObject({ detail: { status: 'failed' } });
    expect(JSON.stringify(events)).not.toContain('must-not-leak');
    expect(JSON.stringify(events)).not.toContain('file contents');
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(
      events.some(
        (event) =>
          'provenance' in event &&
          event.provenance?.provider === 'claude' &&
          event.provenance.model === 'claude-sonnet-4-6' &&
          event.provenance.sessionId === 'session-1',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'activity' && event.provenance?.itemId === 'unknown-1')).toBe(true);
  });

  it('reports none/activity_only/full only from actual exposure', () => {
    const none = createClaudeTelemetryState('claude', 'none');
    const init = translateClaudeTelemetryMessage({ type: 'system', subtype: 'init', session_id: 's' }, none);
    expect(init.some((event) => event.type === 'capability' && event.reasoning === 'none')).toBe(true);

    const redacted = createClaudeTelemetryState('claude', 'high');
    const redactedEvents = translateClaudeTelemetryMessage(
      {
        type: 'stream_event',
        session_id: 's',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } },
      },
      redacted,
    );
    expect(redactedEvents.some((event) => event.type === 'capability' && event.reasoning === 'activity_only')).toBe(
      true,
    );
    expect(
      redactedEvents.some(
        (event) => event.type === 'reasoning' && event.availability === 'activity_only' && !('content' in event),
      ),
    ).toBe(true);

    const full = createClaudeTelemetryState('claude', 'high');
    const fullEvents = translateClaudeTelemetryMessage(
      {
        type: 'stream_event',
        session_id: 's',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'visible thought' },
        },
      },
      full,
    );
    expect(fullEvents.some((event) => event.type === 'capability' && event.reasoning === 'full')).toBe(true);
    expect(
      fullEvents.some(
        (event) => event.type === 'reasoning' && event.availability === 'full' && event.content === 'visible thought',
      ),
    ).toBe(true);
  });

  it('emits structured redacted SDK errors without replacing result behavior', () => {
    const state = createClaudeTelemetryState('claude', 'high');
    const assistant = translateClaudeTelemetryMessage(
      {
        type: 'assistant',
        session_id: 's',
        uuid: 'a',
        error: 'overloaded',
        message: { content: [] },
      },
      state,
    );
    expect(assistant.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      retryable: true,
      classification: 'rate_limit',
      code: 'overloaded',
    });
    const result = translateClaudeTelemetryMessage(
      {
        type: 'result',
        session_id: 's',
        uuid: 'r',
        is_error: true,
        errors: ['api_key=abc billing failure'],
      },
      state,
    );
    expect(result.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      retryable: false,
      classification: 'quota',
      message: 'api_key=[REDACTED] billing failure',
    });
  });

  it('keeps final user output unchanged while telemetry output is redacted', async () => {
    queryFixtures = [
      { type: 'system', subtype: 'init', session_id: 'session-1', uuid: 'init' },
      {
        type: 'stream_event',
        session_id: 'session-1',
        uuid: 'delta',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'token=abc partial' } },
      },
      { type: 'unknown_new_sdk_event', session_id: 'session-1', uuid: 'unknown' },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        uuid: 'result',
        result: 'token=abc final user output',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    ];
    const provider = new ClaudeProvider({ model: 'claude-sonnet-4-6', effort: 'high' });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'token=abc final user output', isError: false },
    ]);
    expect(events.some((event) => event.type === 'output' && event.text.includes('[REDACTED]'))).toBe(true);
    expect(events.some((event) => event.type === 'usage' && event.usage.totalTokens === 14)).toBe(true);
  });

  it('redacts and truncates telemetry strings', () => {
    expect(redactClaudeTelemetry('password=hunter2 Bearer abc.def')).toBe('password=[REDACTED] Bearer [REDACTED]');
    expect(redactClaudeTelemetry('x'.repeat(3_000))).toHaveLength(2_000);
  });
});

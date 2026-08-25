import { describe, expect, it } from 'bun:test';
import { createOpencodeTelemetryState, redactOpencodeTelemetry, translateOpencodeEvent } from './opencode.js';

describe('OpenCode SSE telemetry translation', () => {
  it('orders text/reasoning deltas and tool lifecycle with stable provenance', () => {
    const state = createOpencodeTelemetryState('lmstudio', 'model-a', 'session-1');
    const fixtures = [
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          delta: 'hello ',
          part: { type: 'text', id: 'text-1', messageID: 'msg-1', text: 'hello ' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { type: 'text', id: 'text-1', messageID: 'msg-1', text: 'hello world' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          delta: 'secret=abc thought',
          part: { type: 'reasoning', id: 'reason-1', messageID: 'msg-1', text: 'secret=abc thought' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            type: 'tool',
            id: 'part-1',
            callID: 'call-1',
            messageID: 'msg-1',
            tool: 'bash',
            state: { status: 'pending', input: { password: 'must-not-leak' } },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            type: 'tool',
            id: 'part-1',
            callID: 'call-1',
            messageID: 'msg-1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'cat /secret' }, time: { start: 10 } },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            type: 'tool',
            id: 'part-1',
            callID: 'call-1',
            messageID: 'msg-1',
            tool: 'bash',
            state: { status: 'completed', output: 'file contents' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];
    const events = fixtures.flatMap((fixture) => translateOpencodeEvent(fixture, state));
    const normalized = events.filter((event) => ['output', 'reasoning', 'tool'].includes(event.type));
    expect(normalized.map((event) => (event.type === 'tool' ? `tool.${event.phase}` : event.type))).toEqual([
      'output',
      'output',
      'reasoning',
      'tool.start',
      'tool.progress',
      'tool.complete',
    ]);
    expect(
      events.filter((event) => event.type === 'output').map((event) => (event.type === 'output' ? event.text : '')),
    ).toEqual(['hello ', 'world']);
    expect(events.some((event) => event.type === 'capability' && event.reasoning === 'full')).toBe(true);
    expect(
      events
        .filter((event) => event.type === 'tool')
        .every((event) => event.type === 'tool' && event.toolCallId === 'call-1'),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain('must-not-leak');
    expect(JSON.stringify(events)).not.toContain('file contents');
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(
      events.some(
        (event) =>
          'provenance' in event && event.provenance?.model === 'model-a' && event.provenance.sessionId === 'session-1',
      ),
    ).toBe(true);
  });

  it('handles missing identifiers, unknown events, failures and reasoning-token-only providers', () => {
    const state = createOpencodeTelemetryState('variable-provider', 'model-b', 'session-2');
    const fixtures = [
      {
        type: 'message.part.updated',
        properties: { part: { type: 'tool', tool: 'missing-id', state: { status: 'running', input: { token: 'x' } } } },
      },
      { type: 'future.event', properties: { payload: { password: 'must-not-leak' } } },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id: 'fallback-id',
            tool: 'read',
            state: { status: 'error', error: 'Bearer abc.def failure', output: 'secret file' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: { part: { type: 'step-finish', id: 'step-1', tokens: { input: 5, output: 3, reasoning: 2 } } },
      },
      {
        type: 'session.error',
        properties: { sessionID: 'session-2', error: { name: 'ProviderError', message: 'api_key=abc unauthorized' } },
      },
    ];
    const events = fixtures.flatMap((fixture) => translateOpencodeEvent(fixture, state));
    expect(events.filter((event) => event.type === 'tool')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool')).toMatchObject({
      phase: 'complete',
      toolCallId: 'fallback-id',
      detail: { status: 'failed', error: 'Bearer [REDACTED] failure' },
    });
    expect(events.some((event) => event.type === 'activity' && event.label === 'OpenCode provider activity')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'capability' && event.reasoning === 'activity_only')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'reasoning' && event.availability === 'activity_only' && !('content' in event),
      ),
    ).toBe(true);
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      classification: 'auth',
      code: 'ProviderError',
      message: 'api_key=[REDACTED] unauthorized',
    });
  });

  it('leaves reasoning unknown when providers expose no reasoning signal', () => {
    const state = createOpencodeTelemetryState('minimal', 'model-c', 's');
    const events = translateOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's' } }, state);
    expect(state.reasoning).toBe('unknown');
    expect(events.some((event) => event.type === 'reasoning' || event.type === 'capability')).toBe(false);
    expect(redactOpencodeTelemetry('token=abc')).toBe('token=[REDACTED]');
  });
});

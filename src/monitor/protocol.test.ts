import { describe, expect, it } from 'vitest';
import { deterministicAgents } from './fixtures.js';
import { redactSecrets, validateAgent, validateEvent, validateSnapshot } from './protocol.js';

const event = {
  protocolVersion: '1.0',
  eventId: 'e1',
  cursor: { streamId: 's', sequence: '1' },
  timestamp: new Date(0).toISOString(),
  type: 'agent.status',
  payload: { status: 'idle' },
};
describe('monitor protocol', () => {
  it('accepts compatible unknown fields', () => expect(validateEvent({ ...event, future: true })).toMatchObject(event));
  it('rejects invalid fixtures and major versions', () => {
    expect(() => validateEvent({ ...event, protocolVersion: '2.0' })).toThrow('unsupported_protocol_major');
    expect(() => validateEvent({ ...event, protocolVersion: '1' })).toThrow('unsupported_protocol_major');
    expect(() => validateEvent({ ...event, cursor: { streamId: 's', sequence: 1 } })).toThrow('invalid_cursor');
  });
  it('validates timestamps, optional provenance, coalescing, and status payloads', () => {
    expect(
      validateEvent({
        ...event,
        protocolVersion: '1.9',
        agentGroupId: 'g',
        runtimeId: 'runtime',
        sessionId: 'session',
        commandId: 'command',
        coalescedCount: 2,
        future: true,
        payload: { status: 'waiting', futurePayload: true },
      }),
    ).toMatchObject({ protocolVersion: '1.9', future: true });
    for (const invalid of [
      { timestamp: 'not-a-date' },
      { agentGroupId: '' },
      { coalescedCount: 0 },
      { payload: { status: 'invented' } },
    ])
      expect(() => validateEvent({ ...event, ...invalid })).toThrow();
  });
  it('validates event-specific payload fields while allowing unknown fields', () => {
    expect(
      validateEvent({ ...event, type: 'reasoning.progress', payload: { availability: 'summary', extension: 1 } }),
    ).toMatchObject({ payload: { extension: 1 } });
    expect(() => validateEvent({ ...event, type: 'agent.activity', payload: { label: 1 } })).toThrow('invalid_payload');
    expect(() => validateEvent({ ...event, type: 'error', payload: { message: 4 } })).toThrow('invalid_payload');
    expect(() =>
      validateEvent({ ...event, type: 'command.failure', payload: { code: 'failed', retryable: 'yes' } }),
    ).toThrow('invalid_payload');
    expect(() => validateEvent({ ...event, payload: { status: 'idle', occurredAt: 'yesterday' } })).toThrow(
      'invalid_payload',
    );
  });
  it('validates snapshot version, cursor, agent timestamps, and contents', () => {
    const agent = deterministicAgents(1)[0];
    const snapshot = {
      protocolVersion: '1.4',
      asOf: { streamId: 'stream', sequence: '3' },
      agents: [{ ...agent, extension: true }],
      future: true,
    };
    expect(validateSnapshot(snapshot)).toMatchObject({ future: true });
    expect(() => validateSnapshot({ ...snapshot, protocolVersion: '2.0' })).toThrow('unsupported_protocol_major');
    expect(() => validateSnapshot({ ...snapshot, asOf: { streamId: 'stream', sequence: 3 } })).toThrow(
      'invalid_cursor',
    );
    expect(() => validateSnapshot({ ...snapshot, agents: [{ ...agent, updatedAt: 'invalid' }] })).toThrow(
      'invalid_agent',
    );
  });
  it('enforces reasoning availability', () =>
    expect(() => validateAgent({ ...deterministicAgents(1)[0], reasoningContent: 'private' })).toThrow(
      'reasoning_content_forbidden',
    ));
  it('allows reasoning content for summary', () =>
    expect(
      validateAgent({
        ...deterministicAgents(1)[0],
        reasoningAvailability: 'summary',
        reasoningContent: 'safe summary',
      }),
    ).toMatchObject({ reasoningContent: 'safe summary' }));
  it('produces deterministic 50-agent identity ordering', () =>
    expect(deterministicAgents().map((a) => a.agentGroupId)).toEqual(
      [...deterministicAgents()].map((a) => a.agentGroupId).sort(),
    ));
  it('redacts nested secrets', () =>
    expect(redactSecrets({ apiKey: 'x', nested: { authorization: 'y', ok: 1 } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]', ok: 1 },
    }));
  it('conservatively redacts common free-text credentials without changing ordinary text', () => {
    expect(
      redactSecrets({
        text: 'Authorization: Bearer abcdefghijkl and token=super-secret-value; sk-abcdefghijk',
        ordinary: 'token budget and password policy',
      }),
    ).toEqual({
      text: 'Authorization: Bearer [REDACTED] and token=[REDACTED]; [REDACTED]',
      ordinary: 'token budget and password policy',
    });
  });
});

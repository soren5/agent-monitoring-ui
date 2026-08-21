import { describe, expect, it } from 'vitest';
import { deterministicAgents } from './fixtures.js';
import { redactSecrets, validateAgent, validateEvent } from './protocol.js';

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
    expect(() => validateEvent({ ...event, cursor: { streamId: 's', sequence: 1 } })).toThrow('invalid_cursor');
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
});

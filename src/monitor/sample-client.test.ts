import { describe, expect, it } from 'vitest';
import { SampleClientCursor, validateServerFrame } from './sample-client.js';

const event = (streamId: string, sequence: string) => ({
  protocolVersion: '1.0',
  eventId: `event-${sequence}`,
  cursor: { streamId, sequence },
  timestamp: new Date(0).toISOString(),
  type: 'output',
  payload: { text: 'ok' },
});

describe('sample monitor client protocol', () => {
  it('validates snapshot framing and resumes consecutive events', () => {
    const client = new SampleClientCursor();
    const snapshot = validateServerFrame({
      kind: 'snapshot',
      reason: 'initial',
      snapshot: { protocolVersion: '1.0', asOf: { streamId: 's', sequence: '1' }, agents: [] },
    });
    expect(client.apply(snapshot)).toBe('applied');
    expect(client.apply(validateServerFrame({ kind: 'events', events: [event('s', '2'), event('s', '3')] }))).toBe(
      'applied',
    );
    expect(client.cursor()).toEqual({ streamId: 's', sequence: '3' });
  });
  it('detects gaps and epoch changes so the script can request a fresh snapshot', () => {
    const gap = new SampleClientCursor({ streamId: 's', sequence: '1' });
    expect(gap.apply(validateServerFrame({ kind: 'event', event: event('s', '3') }))).toBe('reconcile');
    const epoch = new SampleClientCursor({ streamId: 's', sequence: '1' });
    expect(epoch.apply(validateServerFrame({ kind: 'event', event: event('new', '2') }))).toBe('reconcile');
  });
  it('rejects malformed framing and incompatible snapshot versions', () => {
    expect(() => validateServerFrame({ kind: 'event', event: { ...event('s', '1'), timestamp: 'bad' } })).toThrow();
    expect(() =>
      validateServerFrame({
        kind: 'snapshot',
        reason: 'initial',
        snapshot: { protocolVersion: '2.0', asOf: { streamId: 's', sequence: '0' }, agents: [] },
      }),
    ).toThrow('unsupported_protocol_major');
  });
});

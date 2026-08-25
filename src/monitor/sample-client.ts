import { validateEvent, validateSnapshot, type Cursor, type MonitorEvent, type MonitorSnapshot } from './protocol.js';

export type ValidatedServerFrame =
  | { kind: 'snapshot'; snapshot: MonitorSnapshot; reason: string }
  | { kind: 'events'; events: MonitorEvent[] }
  | { kind: 'event'; event: MonitorEvent }
  | { kind: 'command'; value: Record<string, unknown> }
  | { kind: 'error'; error: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_server_frame');
  return value as Record<string, unknown>;
}

export function validateServerFrame(value: unknown): ValidatedServerFrame {
  const frame = record(value);
  if (typeof frame.error === 'string') return { kind: 'error', error: frame.error };
  if (frame.kind === 'snapshot') {
    if (typeof frame.reason !== 'string') throw new Error('invalid_server_frame');
    return { kind: 'snapshot', snapshot: validateSnapshot(frame.snapshot), reason: frame.reason };
  }
  if (frame.kind === 'events') {
    if (!Array.isArray(frame.events)) throw new Error('invalid_server_frame');
    return { kind: 'events', events: frame.events.map(validateEvent) };
  }
  if (frame.kind === 'event') return { kind: 'event', event: validateEvent(frame.event) };
  if (
    typeof frame.commandId === 'string' &&
    frame.commandId.length > 0 &&
    ['ack', 'success', 'failure'].includes(String(frame.status))
  )
    return { kind: 'command', value: frame };
  throw new Error('invalid_server_frame');
}

export class SampleClientCursor {
  private value?: Cursor;
  constructor(after?: Cursor) {
    if (after) {
      if (
        typeof after.streamId !== 'string' ||
        !after.streamId ||
        typeof after.sequence !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(after.sequence)
      )
        throw new Error('invalid_cursor');
      this.value = after;
    }
  }
  cursor(): Cursor | undefined {
    return this.value;
  }
  apply(frame: ValidatedServerFrame): 'applied' | 'duplicate' | 'reconcile' | 'other' {
    if (frame.kind === 'snapshot') {
      this.value = frame.snapshot.asOf;
      return 'applied';
    }
    const events = frame.kind === 'events' ? frame.events : frame.kind === 'event' ? [frame.event] : undefined;
    if (!events) return 'other';
    let applied = false;
    for (const event of events) {
      if (!this.value || event.cursor.streamId !== this.value.streamId) return 'reconcile';
      const current = BigInt(this.value.sequence);
      const next = BigInt(event.cursor.sequence);
      if (next <= current) continue;
      if (next !== current + 1n) return 'reconcile';
      this.value = event.cursor;
      applied = true;
    }
    return applied ? 'applied' : 'duplicate';
  }
}

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  MONITOR_PROTOCOL_VERSION,
  redactSecrets,
  validateAgent,
  validateEvent,
  type AgentProjection,
  type Cursor,
  type MonitorEvent,
  type MonitorEventType,
  type MonitorSnapshot,
} from './protocol.js';

const NEVER_DROP = new Set<MonitorEventType>([
  'agent.status',
  'chat.in',
  'chat.out',
  'error',
  'tool.complete',
  'command.ack',
  'command.success',
  'command.failure',
]);
export type ResumeResult =
  | { kind: 'events'; events: MonitorEvent[] }
  | { kind: 'snapshot'; snapshot: MonitorSnapshot; reason: 'initial' | 'gap' | 'obsolete_epoch' };

export class MonitorPublisher extends EventEmitter {
  readonly streamId = randomUUID();
  private sequence = 0n;
  private readonly retained: MonitorEvent[] = [];
  private readonly agents = new Map<string, AgentProjection>();
  private readonly eventsById = new Map<string, MonitorEvent>();
  constructor(private readonly retention = 10_000) {
    super();
  }
  cursor(): Cursor {
    return { streamId: this.streamId, sequence: String(this.sequence) };
  }
  snapshot(): MonitorSnapshot {
    return {
      protocolVersion: MONITOR_PROTOCOL_VERSION,
      asOf: this.cursor(),
      agents: [...this.agents.values()].sort((a, b) => a.agentGroupId.localeCompare(b.agentGroupId)),
    };
  }
  publish(
    type: MonitorEventType,
    agentGroupId: string | undefined,
    payload: Record<string, unknown>,
    provenance: {
      runtimeId?: string;
      sessionId?: string;
      commandId?: string;
      eventId?: string;
      coalescedCount?: number;
    } = {},
  ): MonitorEvent {
    const eventId = provenance.eventId ?? randomUUID();
    const duplicate = this.eventsById.get(eventId);
    if (duplicate) return duplicate;
    this.sequence++;
    const event = validateEvent(
      redactSecrets({
        protocolVersion: MONITOR_PROTOCOL_VERSION,
        eventId,
        cursor: this.cursor(),
        timestamp: new Date().toISOString(),
        type,
        agentGroupId,
        ...provenance,
        payload,
      }),
    );
    this.eventsById.set(eventId, event);
    this.project(event);
    this.retained.push(event);
    while (this.retained.length > this.retention) this.retained.shift();
    this.emit('event', event);
    return event;
  }
  resume(after?: Cursor): ResumeResult {
    if (!after) return { kind: 'snapshot', snapshot: this.snapshot(), reason: 'initial' };
    if (after.streamId !== this.streamId)
      return { kind: 'snapshot', snapshot: this.snapshot(), reason: 'obsolete_epoch' };
    const seq = BigInt(after.sequence);
    const first = this.retained[0] ? BigInt(this.retained[0].cursor.sequence) : this.sequence + 1n;
    if (seq < first - 1n || seq > this.sequence) return { kind: 'snapshot', snapshot: this.snapshot(), reason: 'gap' };
    return { kind: 'events', events: this.retained.filter((e) => BigInt(e.cursor.sequence) > seq) };
  }
  private project(e: MonitorEvent): void {
    if (!e.agentGroupId) return;
    if (e.type === 'agent.remove') {
      this.agents.delete(e.agentGroupId);
      return;
    }
    const old = this.agents.get(e.agentGroupId);
    if (e.type === 'agent.upsert')
      this.agents.set(
        e.agentGroupId,
        validateAgent({
          ...old,
          ...e.payload,
          agentGroupId: e.agentGroupId,
          runtimeId: e.runtimeId,
          sessionId: e.sessionId,
          updatedAt: e.timestamp,
        }),
      );
    else if (old && e.type === 'agent.status')
      this.agents.set(e.agentGroupId, {
        ...old,
        status: e.payload.status as AgentProjection['status'],
        hasBlockers: Boolean(e.payload.hasBlockers),
        updatedAt: e.timestamp,
      });
    else if (old && e.type === 'agent.activity')
      this.agents.set(e.agentGroupId, { ...old, activity: String(e.payload.label ?? ''), updatedAt: e.timestamp });
  }
  static isDroppable(type: MonitorEventType): boolean {
    return (
      !NEVER_DROP.has(type) && (type === 'tool.progress' || type === 'reasoning.progress' || type === 'agent.activity')
    );
  }
}

export class ClientProjection {
  stale = true;
  cursor?: Cursor;
  agents = new Map<string, AgentProjection>();
  applySnapshot(s: MonitorSnapshot): void {
    this.agents = new Map(s.agents.map((a) => [a.agentGroupId, a]));
    this.cursor = s.asOf;
    this.stale = false;
  }
  disconnect(): void {
    this.stale = true;
  }
  accept(e: MonitorEvent): 'applied' | 'duplicate' | 'reconcile' {
    if (this.cursor?.streamId !== e.cursor.streamId) return 'reconcile';
    const expected = BigInt(this.cursor.sequence) + 1n,
      got = BigInt(e.cursor.sequence);
    if (got <= BigInt(this.cursor.sequence)) return 'duplicate';
    if (got !== expected) return 'reconcile';
    this.cursor = e.cursor;
    return 'applied';
  }
}

/** Bounded noisy-progress coalescer. Non-droppable events always bypass it. */
export class ProgressCoalescer {
  private pending = new Map<
    string,
    {
      type: MonitorEventType;
      agentGroupId: string | undefined;
      payload: Record<string, unknown>;
      count: number;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private publisher: MonitorPublisher,
    private maxDelayMs = 5_000,
  ) {}
  push(
    type: MonitorEventType,
    agentGroupId: string | undefined,
    payload: Record<string, unknown>,
  ): MonitorEvent | undefined {
    if (!MonitorPublisher.isDroppable(type)) return this.publisher.publish(type, agentGroupId, payload);
    const key = `${type}:${agentGroupId ?? ''}`;
    const prior = this.pending.get(key);
    if (prior) {
      prior.payload = payload;
      prior.count++;
      return;
    }
    const item = { type, agentGroupId, payload, count: 1, timer: setTimeout(() => this.flush(key), this.maxDelayMs) };
    this.pending.set(key, item);
    return;
  }
  flush(key?: string): void {
    for (const k of key ? [key] : [...this.pending.keys()]) {
      const item = this.pending.get(k);
      if (!item) continue;
      clearTimeout(item.timer);
      this.pending.delete(k);
      this.publisher.publish(item.type, item.agentGroupId, item.payload, { coalescedCount: item.count });
    }
  }
  close(): void {
    this.flush();
  }
}

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
export interface MonitorEventProvenance {
  runtimeId?: string;
  sessionId?: string;
  commandId?: string;
  eventId?: string;
  coalescedCount?: number;
}

export class MonitorPublisher extends EventEmitter {
  readonly streamId = randomUUID();
  private sequence = 0n;
  private readonly retained: MonitorEvent[] = [];
  private readonly agents = new Map<string, AgentProjection>();
  private readonly eventsById = new Map<string, MonitorEvent>();
  constructor(private readonly retention = 10_000) {
    super();
    if (!Number.isSafeInteger(retention) || retention < 1) throw new Error('retention_must_be_positive_integer');
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
  historyStats(): { retainedEvents: number; dedupeIds: number } {
    return { retainedEvents: this.retained.length, dedupeIds: this.eventsById.size };
  }
  publish(
    type: MonitorEventType,
    agentGroupId: string | undefined,
    payload: Record<string, unknown>,
    provenance: MonitorEventProvenance = {},
  ): MonitorEvent {
    const eventId = provenance.eventId ?? randomUUID();
    const duplicate = this.eventsById.get(eventId);
    if (duplicate) return duplicate;
    const nextSequence = this.sequence + 1n;
    const event = validateEvent({
      protocolVersion: MONITOR_PROTOCOL_VERSION,
      eventId,
      cursor: { streamId: this.streamId, sequence: String(nextSequence) },
      timestamp: new Date().toISOString(),
      type,
      agentGroupId,
      ...provenance,
      payload: redactSecrets(payload),
    });
    if (this.startsNewSession(type, agentGroupId, provenance.sessionId)) this.clearHistory();
    this.sequence = nextSequence;
    this.eventsById.set(eventId, event);
    this.project(event);
    this.retained.push(event);
    while (this.retained.length > this.retention) {
      const evicted = this.retained.shift();
      if (evicted) this.eventsById.delete(evicted.eventId);
    }
    this.emit('event', event);
    return event;
  }
  private startsNewSession(
    type: MonitorEventType,
    agentGroupId: string | undefined,
    sessionId: string | undefined,
  ): boolean {
    if (!agentGroupId) return false;
    const current = this.agents.get(agentGroupId);
    if (!current) return false;
    if (type === 'agent.remove') return true;
    return type === 'agent.upsert' && current.sessionId !== sessionId;
  }
  private clearHistory(): void {
    // The stream cursor is global, so selectively removing one session could
    // leave holes between other agents' events. Starting a contiguous suffix
    // at the rollover boundary preserves resume/gap guarantees while ensuring
    // no previous-session event remains available as monitor history.
    this.retained.length = 0;
    this.eventsById.clear();
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
        hasBlockers: typeof e.payload.hasBlockers === 'boolean' ? e.payload.hasBlockers : old.hasBlockers,
        updatedAt: e.timestamp,
      });
    else if (old && e.type === 'agent.activity')
      this.agents.set(e.agentGroupId, {
        ...old,
        activity: String(e.payload.label ?? ''),
        reasoningAvailability: isReasoningAvailability(e.payload.reasoning)
          ? e.payload.reasoning
          : old.reasoningAvailability,
        updatedAt: e.timestamp,
      });
    else if (old && e.type === 'reasoning.progress' && isReasoningAvailability(e.payload.availability))
      this.agents.set(e.agentGroupId, {
        ...old,
        reasoningAvailability: e.payload.availability,
        updatedAt: e.timestamp,
      });
  }
  static isDroppable(type: MonitorEventType): boolean {
    return (
      !NEVER_DROP.has(type) && (type === 'tool.progress' || type === 'reasoning.progress' || type === 'agent.activity')
    );
  }
}

function isReasoningAvailability(value: unknown): value is AgentProjection['reasoningAvailability'] {
  return ['full', 'summary', 'activity_only', 'none', 'unknown'].includes(String(value));
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
      provenance: MonitorEventProvenance;
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
    provenance: MonitorEventProvenance = {},
  ): MonitorEvent | undefined {
    if (!MonitorPublisher.isDroppable(type)) {
      // A critical event bypasses the delay, not the stream order: publish any
      // older progress first, then the critical event immediately.
      this.flush();
      return this.publisher.publish(type, agentGroupId, payload, provenance);
    }
    const key = `${type}:${agentGroupId ?? ''}:${provenance.sessionId ?? ''}`;
    const prior = this.pending.get(key);
    if (prior) {
      prior.payload = payload;
      prior.provenance = provenance;
      prior.count++;
      return;
    }
    const item = {
      type,
      agentGroupId,
      payload,
      provenance,
      count: 1,
      timer: setTimeout(() => this.flush(key), this.maxDelayMs),
    };
    this.pending.set(key, item);
    return;
  }
  flush(key?: string): void {
    for (const k of key ? [key] : [...this.pending.keys()]) {
      const item = this.pending.get(k);
      if (!item) continue;
      clearTimeout(item.timer);
      this.pending.delete(k);
      this.publisher.publish(item.type, item.agentGroupId, item.payload, {
        ...item.provenance,
        coalescedCount: item.count,
      });
    }
  }
  close(): void {
    this.flush();
  }
}

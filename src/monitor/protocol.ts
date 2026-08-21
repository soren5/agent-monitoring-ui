export const MONITOR_PROTOCOL_VERSION = '1.0';

export type AgentStatus =
  | 'starting'
  | 'idle'
  | 'in_progress'
  | 'blocked'
  | 'waiting'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unknown';
export type ReasoningAvailability = 'full' | 'summary' | 'activity_only' | 'none' | 'unknown';
export type MonitorEventType =
  | 'agent.upsert'
  | 'agent.remove'
  | 'agent.status'
  | 'agent.activity'
  | 'chat.in'
  | 'chat.out'
  | 'reasoning.progress'
  | 'tool.start'
  | 'tool.progress'
  | 'tool.complete'
  | 'output'
  | 'error'
  | 'command.ack'
  | 'command.success'
  | 'command.failure';

export interface Cursor {
  streamId: string;
  sequence: string;
}
export interface AgentProjection {
  agentGroupId: string;
  runtimeId?: string;
  sessionId?: string;
  status: AgentStatus;
  hasBlockers: boolean;
  reasoningAvailability: ReasoningAvailability;
  reasoningContent?: string;
  updatedAt: string;
  activity?: string;
}
export interface MonitorEvent {
  protocolVersion: string;
  eventId: string;
  cursor: Cursor;
  timestamp: string;
  type: MonitorEventType;
  agentGroupId?: string;
  runtimeId?: string;
  sessionId?: string;
  commandId?: string;
  payload: Record<string, unknown>;
  coalescedCount?: number;
}
export interface MonitorSnapshot {
  protocolVersion: string;
  asOf: Cursor;
  agents: AgentProjection[];
}

const statuses = new Set<AgentStatus>([
  'starting',
  'idle',
  'in_progress',
  'blocked',
  'waiting',
  'stopping',
  'stopped',
  'failed',
  'unknown',
]);
const reasoning = new Set<ReasoningAvailability>(['full', 'summary', 'activity_only', 'none', 'unknown']);
const types = new Set<MonitorEventType>([
  'agent.upsert',
  'agent.remove',
  'agent.status',
  'agent.activity',
  'chat.in',
  'chat.out',
  'reasoning.progress',
  'tool.start',
  'tool.progress',
  'tool.complete',
  'output',
  'error',
  'command.ack',
  'command.success',
  'command.failure',
]);

export function isDecimalSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}
export function assertCompatibleVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.split('.')[0] !== MONITOR_PROTOCOL_VERSION.split('.')[0]) {
    throw new Error('unsupported_protocol_major');
  }
}
export function validateEvent(value: unknown): MonitorEvent {
  if (!value || typeof value !== 'object') throw new Error('invalid_event');
  const v = value as Record<string, unknown>;
  assertCompatibleVersion(v.protocolVersion);
  if (
    typeof v.eventId !== 'string' ||
    !v.eventId ||
    typeof v.timestamp !== 'string' ||
    !types.has(v.type as MonitorEventType)
  )
    throw new Error('invalid_event');
  if (!v.cursor || typeof v.cursor !== 'object') throw new Error('invalid_cursor');
  const c = v.cursor as Record<string, unknown>;
  if (typeof c.streamId !== 'string' || !c.streamId || !isDecimalSequence(c.sequence))
    throw new Error('invalid_cursor');
  if (!v.payload || typeof v.payload !== 'object' || Array.isArray(v.payload)) throw new Error('invalid_payload');
  return value as MonitorEvent;
}
export function validateAgent(value: unknown): AgentProjection {
  if (!value || typeof value !== 'object') throw new Error('invalid_agent');
  const v = value as Record<string, unknown>;
  if (
    typeof v.agentGroupId !== 'string' ||
    !statuses.has(v.status as AgentStatus) ||
    typeof v.hasBlockers !== 'boolean' ||
    !reasoning.has(v.reasoningAvailability as ReasoningAvailability) ||
    typeof v.updatedAt !== 'string'
  )
    throw new Error('invalid_agent');
  if (v.reasoningContent !== undefined && !['full', 'summary'].includes(v.reasoningAvailability as string))
    throw new Error('reasoning_content_forbidden');
  return value as AgentProjection;
}

/** Recursively redacts common credential fields before telemetry leaves the publisher. */
export function redactSecrets<T>(input: T): T {
  const visit = (v: unknown, key = ''): unknown => {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key)) return '[REDACTED]';
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  return visit(input) as T;
}

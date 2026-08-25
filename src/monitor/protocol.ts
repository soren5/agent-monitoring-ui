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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}
function validateCursor(value: unknown): asserts value is Cursor {
  if (!isRecord(value) || !isNonEmptyString(value.streamId) || !isDecimalSequence(value.sequence))
    throw new Error('invalid_cursor');
}

export function isDecimalSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}
export function assertCompatibleVersion(value: unknown): asserts value is string {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)(?:\.[0-9A-Za-z.-]+)?$/.exec(value) : null;
  if (!match || match[1] !== MONITOR_PROTOCOL_VERSION.split('.')[0]) {
    throw new Error('unsupported_protocol_major');
  }
}
export function validateEvent(value: unknown): MonitorEvent {
  if (!isRecord(value)) throw new Error('invalid_event');
  const v = value;
  assertCompatibleVersion(v.protocolVersion);
  if (
    !isNonEmptyString(v.eventId) ||
    !isTimestamp(v.timestamp) ||
    !types.has(v.type as MonitorEventType) ||
    !optionalString(v.agentGroupId) ||
    !optionalString(v.runtimeId) ||
    !optionalString(v.sessionId) ||
    !optionalString(v.commandId) ||
    (v.coalescedCount !== undefined && (!Number.isSafeInteger(v.coalescedCount) || Number(v.coalescedCount) < 1))
  )
    throw new Error('invalid_event');
  validateCursor(v.cursor);
  if (!isRecord(v.payload)) throw new Error('invalid_payload');
  validatePayload(v.type as MonitorEventType, v.payload);
  return value as unknown as MonitorEvent;
}
export function validateAgent(value: unknown): AgentProjection {
  if (!isRecord(value)) throw new Error('invalid_agent');
  const v = value;
  if (
    !isNonEmptyString(v.agentGroupId) ||
    !optionalString(v.runtimeId) ||
    !optionalString(v.sessionId) ||
    !statuses.has(v.status as AgentStatus) ||
    typeof v.hasBlockers !== 'boolean' ||
    !reasoning.has(v.reasoningAvailability as ReasoningAvailability) ||
    !isTimestamp(v.updatedAt) ||
    (v.activity !== undefined && typeof v.activity !== 'string') ||
    (v.reasoningContent !== undefined && typeof v.reasoningContent !== 'string')
  )
    throw new Error('invalid_agent');
  if (v.reasoningContent !== undefined && !['full', 'summary'].includes(v.reasoningAvailability as string))
    throw new Error('reasoning_content_forbidden');
  return value as unknown as AgentProjection;
}

export function validateSnapshot(value: unknown): MonitorSnapshot {
  if (!isRecord(value)) throw new Error('invalid_snapshot');
  assertCompatibleVersion(value.protocolVersion);
  validateCursor(value.asOf);
  if (!Array.isArray(value.agents)) throw new Error('invalid_snapshot');
  for (const agent of value.agents) validateAgent(agent);
  return value as unknown as MonitorSnapshot;
}

function validatePayload(type: MonitorEventType, payload: Record<string, unknown>): void {
  if (payload.occurredAt !== undefined && !isTimestamp(payload.occurredAt)) throw new Error('invalid_payload');
  if (payload.provenance !== undefined && !isRecord(payload.provenance)) throw new Error('invalid_payload');
  if (
    payload.schemaVersion !== undefined &&
    (!Number.isSafeInteger(payload.schemaVersion) || Number(payload.schemaVersion) < 1)
  )
    throw new Error('invalid_payload');
  switch (type) {
    case 'agent.upsert':
      validateAgent({ ...payload, agentGroupId: 'payload', updatedAt: new Date(0).toISOString() });
      break;
    case 'agent.status':
      if (!statuses.has(payload.status as AgentStatus)) throw new Error('invalid_payload');
      if (payload.hasBlockers !== undefined && typeof payload.hasBlockers !== 'boolean')
        throw new Error('invalid_payload');
      break;
    case 'agent.activity':
      if (typeof payload.label !== 'string') throw new Error('invalid_payload');
      if (payload.reasoning !== undefined && !reasoning.has(payload.reasoning as ReasoningAvailability))
        throw new Error('invalid_payload');
      break;
    case 'reasoning.progress':
      if (!reasoning.has(payload.availability as ReasoningAvailability)) throw new Error('invalid_payload');
      if (payload.content !== undefined && typeof payload.content !== 'string') throw new Error('invalid_payload');
      break;
    case 'tool.start':
    case 'tool.progress':
    case 'tool.complete':
      if (payload.name !== undefined && typeof payload.name !== 'string') throw new Error('invalid_payload');
      break;
    case 'error':
      if (typeof payload.message !== 'string') throw new Error('invalid_payload');
      break;
    case 'command.ack':
      if (typeof payload.accepted !== 'boolean') throw new Error('invalid_payload');
      break;
    case 'command.success':
      if (payload.code !== undefined && typeof payload.code !== 'string') throw new Error('invalid_payload');
      if (payload.detail !== undefined && typeof payload.detail !== 'string') throw new Error('invalid_payload');
      break;
    case 'command.failure':
      if (typeof payload.code !== 'string') throw new Error('invalid_payload');
      if (payload.detail !== undefined && typeof payload.detail !== 'string') throw new Error('invalid_payload');
      if (payload.retryable !== undefined && typeof payload.retryable !== 'boolean') throw new Error('invalid_payload');
      break;
  }
}

/** Recursively redacts common credential fields before telemetry leaves the publisher. */
export function redactSecrets<T>(input: T): T {
  const visit = (v: unknown, key = ''): unknown => {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key)) return '[REDACTED]';
    if (typeof v === 'string') return redactSecretText(v);
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  return visit(input) as T;
}

function redactSecretText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*([:=])\s*([^\s,;]+)/gi, '$1$2[REDACTED]');
}

import type { AgentProjection } from './protocol.js';

export function deterministicAgents(count = 50): AgentProjection[] {
  return Array.from({ length: count }, (_, i) => ({
    agentGroupId: `agent-${String(i + 1).padStart(3, '0')}`,
    runtimeId: `runtime-${i + 1}`,
    sessionId: `session-${i + 1}`,
    status: i % 2 ? 'idle' : 'in_progress',
    hasBlockers: i % 7 === 0,
    reasoningAvailability: 'activity_only',
    updatedAt: new Date(i * 1000).toISOString(),
  }));
}

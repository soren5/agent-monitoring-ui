import { randomUUID } from 'crypto';
import type { Session } from '../types.js';
import type { HostMessageDelivery } from './commands.js';

export function createHostMessageDelivery(deps: {
  find: (agentGroupId: string) => Session | undefined;
  write: (
    agentGroupId: string,
    sessionId: string,
    message: { id: string; kind: string; timestamp: string; content: string; trigger: 1 },
  ) => void;
  wake: (session: Session) => Promise<boolean>;
}): HostMessageDelivery {
  return async (agentGroupId, body) => {
    const session = deps.find(agentGroupId);
    if (!session) return { delivered: false, detail: 'inactive_agent' };
    deps.write(agentGroupId, session.id, {
      id: `monitor-${randomUUID()}`,
      kind: 'agent',
      timestamp: new Date().toISOString(),
      content: body,
      trigger: 1,
    });
    return (await deps.wake(session)) ? { delivered: true } : { delivered: false, detail: 'wake_failed' };
  };
}

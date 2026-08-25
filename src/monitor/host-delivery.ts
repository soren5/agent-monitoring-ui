import { createHash } from 'crypto';
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
  return async (agentGroupId, body, commandId) => {
    const session = deps.find(agentGroupId);
    if (!session) return { queued: false, detail: 'inactive_agent', retryable: true };
    const messageId = `monitor-command-${createHash('sha256').update(commandId).digest('hex')}`;
    try {
      deps.write(agentGroupId, session.id, {
        id: messageId,
        kind: 'agent',
        timestamp: new Date().toISOString(),
        content: body,
        trigger: 1,
      });
    } catch (error) {
      // Stable message identity makes a uniqueness violation evidence that a
      // prior attempt already durably queued this exact command.
      const message = error instanceof Error ? error.message : String(error);
      if (!/unique|constraint/i.test(message)) throw error;
    }
    const woke = await deps.wake(session);
    return { queued: true, wakeRequested: woke, detail: woke ? undefined : 'wake_failed_message_remains_queued' };
  };
}

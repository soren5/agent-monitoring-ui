/** Capability-gated parent-to-existing-child dispatch. */
import { randomUUID } from 'crypto';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeSessionMessage } from '../../session-manager.js';
import { notifyAgent } from '../approvals/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { findEffectiveGrant } from './capabilities.js';
import type { Session } from '../../types.js';

export async function handleDispatchChild(content: Record<string, unknown>, parent: Session): Promise<void> {
  const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
  const task = typeof content.task === 'string' ? content.task : '';
  if (
    !child ||
    !task ||
    task.length > 12_000 ||
    !hasDestination(parent.agent_group_id, 'agent', child) ||
    !findEffectiveGrant(parent.agent_group_id, {
      resourceType: 'factory-relation',
      resourceId: child,
      action: 'dispatch-child',
    })
  ) {
    notifyAgent(parent, 'Dispatch denied: no live parent-to-child dispatch capability.');
    return;
  }
  const target = findSessionByAgentGroup(child);
  if (!target) {
    notifyAgent(parent, 'Dispatch denied: child has no active existing session.');
    return;
  }
  writeSessionMessage(child, target.id, {
    id: `dispatch-${randomUUID()}`,
    kind: 'agent',
    timestamp: new Date().toISOString(),
    content: task,
    trigger: 1,
    sourceSessionId: parent.id,
  });
  wakeContainer(target);
  notifyAgent(parent, `Dispatch accepted for ${child}.`);
}

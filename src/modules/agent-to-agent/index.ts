/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers its guard-catalog entries (./guard.js) and one guard-wrapped
 * delivery action (`create_agent`) — `create_agent` writes central-DB state,
 * so the guard's agents.create decision holds confined (non-global) groups
 * for admin approval while trusted global-scope groups create directly; the
 * approval handler re-enters the wrapped action carrying the approval row as
 * its grant. The sibling `channel_type === 'agent'` routing path is NOT a
 * system action — core `delivery.ts` dispatches into `./agent-route.js` via
 * a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, `create_agent`
 * system action logs "Unknown system action", `channel_type='agent'` messages
 * throw because the module isn't installed.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION } from './agent-route.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';
import { handleFactoryAction } from './factory.js';
import { handleRepositoryAction } from './repository.js';
import { handleDispatchChild } from './dispatch.js';
import { handleProjectAction } from './projects.js';
import { handleProvisionAction } from './provisioning.js';
import { unguarded } from '../../guard/index.js';
import { agentsCreate } from './guard.js';
import { applyA2aMessageGate } from './message-gate.js';

registerDeliveryAction('create_agent', createAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});
registerApprovalHandler('create_agent', reenterGuardedDeliveryAction('create_agent'));

// The handler is explicitly unguarded at the delivery registry because it
// performs its own host-side principal and ownership checks before every
// operation; no container-provided actor is accepted.
registerDeliveryAction(
  'factory.list_agents',
  handleFactoryAction,
  unguarded('factory handler authenticates Copilot and authorizes every operation'),
);
registerDeliveryAction(
  'factory.get_agent',
  handleFactoryAction,
  unguarded('factory handler authenticates Copilot and authorizes every operation'),
);
registerDeliveryAction(
  'factory.create_local_agent',
  handleFactoryAction,
  unguarded('factory handler authenticates Copilot and authorizes every operation'),
);
registerDeliveryAction(
  'factory.update_instructions',
  handleFactoryAction,
  unguarded('factory handler authenticates Copilot and authorizes every operation'),
);
registerDeliveryAction(
  'factory.request_capability_change',
  handleFactoryAction,
  unguarded('factory handler authenticates Copilot and authorizes every operation'),
);
for (const action of ['factory.wire_agent_channel', 'factory.list_channel_wirings', 'factory.unwire_agent_channel'])
  registerDeliveryAction(action, handleFactoryAction, unguarded('factory handler enforces host grants'));

registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate);
for (const action of [
  'repository.get_metadata',
  'repository.create_branch',
  'repository.write_file',
  'repository.create_pr',
  'repository.merge_pr',
])
  registerDeliveryAction(action, handleRepositoryAction, unguarded('repository handler enforces host grants'));
registerDeliveryAction(
  'factory.dispatch_child',
  handleDispatchChild,
  unguarded('dispatch handler enforces host relation grant'),
);
registerDeliveryAction(
  'provision.request',
  handleProvisionAction,
  unguarded('provisioning handler uses authenticated session and owner approval before materialization'),
);
for (const action of [
  'provision.activate',
  'provision.dispatch',
  'provision.get_status',
  'provision.wake',
  'provision.smoke',
  'provision.get_smoke',
  'provision.list_children',
  'provision.remove',
]) {
  registerDeliveryAction(
    action,
    handleProvisionAction,
    unguarded('provisioning lifecycle handler verifies direct relation and derived capability'),
  );
}
for (const action of [
  'project.create_child',
  'project.dispatch_child',
  'project.wire_descendant',
  'project.remove_descendant',
  'project.list_agents',
  'project.get_status',
]) {
  registerDeliveryAction(
    action,
    handleProjectAction,
    unguarded('project handler enforces host capability and project-relation checks'),
  );
}

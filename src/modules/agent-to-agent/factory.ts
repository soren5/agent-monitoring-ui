/**
 * Copilot Agent Factory: a host-only management boundary for Copilot's
 * explicitly enrolled local-model specialists. The container only submits
 * requests; all identity, ownership, configuration and filesystem checks live
 * here on the host.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getAgentGroup, getAgentGroupByFolder, createAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { PERSONA_PREPEND_FILE, readGroupPersona } from '../../group-persona.js';
import { log } from '../../log.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
} from '../approvals/index.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from './db/agent-destinations.js';
import { findEffectiveGrant } from './capabilities.js';
import { writeDestinations } from './write-destinations.js';
import type { AgentGroup, MessagingGroupAgent, Session } from '../../types.js';

export const COPILOT_FACTORY_GROUP_ID = 'ag-2368054c-2186-47cd-9ebe-4d4868176377';
const LOCAL_MODELS = new Set(['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b']);
const ROLES = new Set(['researcher', 'reviewer', 'classifier', 'formatter']);
const ENROLLABLE_TEMPLATES = new Set([...ROLES, 'requirements', 'benchmarker', 'librarian', 'junior']);
const MAX_PATCH_CHARS = 8_000;
const CAPABILITIES = new Set([
  'additional_read_only_data',
  'narrow_writable_store',
  'provider_model_change',
  'package_requirement',
  'hosted_credential_route',
  'github',
  'deployment',
  'docker',
  'access_control',
]);

type ManagedRow = {
  agent_group_id: string;
  factory_parent_group_id: string;
  template_id: string;
  instruction_revision: string;
  enrolled_at: string;
  enrolled_by_owner_id: string | null;
};

type FactoryChannelWiring = {
  wiring_id: string;
  factory_parent_group_id: string;
  agent_group_id: string;
  channel_type: string;
  platform_id: string;
  messaging_group_id: string | null;
  destination_local_name: string;
  created_messaging_group: number;
  policy_json: string;
  created_at: string;
  revoked_at: string | null;
};

const DISCORD_PLATFORM_ID = /^discord:([1-9][0-9]{4,24}):([1-9][0-9]{4,24})$/;
const FACTORY_CHANNEL_POLICY = {
  engage_mode: 'mention-sticky',
  sender_scope: 'known',
  unknown_sender_policy: 'strict',
  session_mode: 'per-thread',
  ignored_message_policy: 'drop',
  threads: 1,
  priority: 0,
} as const;

function sha(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function audit(
  caller: string,
  target: string | null,
  operation: string,
  outcome: string,
  request: unknown,
  revision?: string,
  approvalId?: string,
): void {
  if (!hasTable(getDb(), 'factory_audit_events')) return;
  getDb()
    .prepare(
      `INSERT INTO factory_audit_events
    (created_at, caller_group_id, target_group_id, operation, outcome, request_hash, resulting_revision, approval_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      caller,
      target,
      operation,
      outcome,
      sha(request),
      revision ?? null,
      approvalId ?? null,
    );
}

function result(session: Session, payload: Record<string, unknown>): void {
  notifyAgent(session, `Factory result: ${JSON.stringify(payload)}`);
}

function isCopilot(session: Session): boolean {
  return session.agent_group_id === COPILOT_FACTORY_GROUP_ID;
}
function managed(id: string): ManagedRow | undefined {
  if (!hasTable(getDb(), 'factory_managed_agents')) return undefined;
  return getDb()
    .prepare('SELECT * FROM factory_managed_agents WHERE agent_group_id = ? AND factory_parent_group_id = ?')
    .get(id, COPILOT_FACTORY_GROUP_ID) as ManagedRow | undefined;
}

function channelWiring(
  agentGroupId: string,
  channelType: string,
  platformId: string,
): FactoryChannelWiring | undefined {
  if (!hasTable(getDb(), 'factory_channel_wirings')) return undefined;
  return getDb()
    .prepare(
      `SELECT * FROM factory_channel_wirings
       WHERE factory_parent_group_id=? AND agent_group_id=? AND channel_type=? AND platform_id=? AND revoked_at IS NULL`,
    )
    .get(COPILOT_FACTORY_GROUP_ID, agentGroupId, channelType, platformId) as FactoryChannelWiring | undefined;
}

function validateDiscordChannel(channelType: unknown, platformId: unknown): string | undefined {
  if (channelType !== 'discord' || typeof platformId !== 'string') return undefined;
  const match = DISCORD_PLATFORM_ID.exec(platformId);
  // A canonical server-qualified ID is required. `discord:@me:*` is a DM and
  // deliberately cannot pass this validation.
  return match ? `discord:${match[1]}:${match[2]}` : undefined;
}

function hasChannelGrant(session: Session, target: string, platformId: string): boolean {
  return !!findEffectiveGrant(session.agent_group_id, {
    resourceType: 'channel',
    resourceId: platformId,
    action: 'wire-descendant',
    constraints: { descendant_agent_group_id: target },
  });
}

function projectDestinations(agentGroupId: string): number {
  let projected = 0;
  for (const targetSession of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, targetSession.id);
      projected++;
    } catch (err) {
      log.warn('Factory channel wiring could not project destinations', {
        agentGroupId,
        sessionId: targetSession.id,
        err,
      });
    }
  }
  return projected;
}

function localChannelName(agentGroupId: string): string {
  let name = 'discord';
  let suffix = 2;
  while (getDestinationByName(agentGroupId, name)) name = `discord-${suffix++}`;
  return name;
}

function wirePayload(wiring: FactoryChannelWiring): Record<string, unknown> {
  return {
    wiring_id: wiring.wiring_id,
    agent_group_id: wiring.agent_group_id,
    channel_type: wiring.channel_type,
    platform_id: wiring.platform_id,
    policy: JSON.parse(wiring.policy_json) as Record<string, unknown>,
    status: 'wired',
  };
}
function deny(
  session: Session,
  operation: string,
  content: Record<string, unknown>,
  reason: string,
  target: string | null = null,
): void {
  audit(session.agent_group_id, target, operation, 'denied', content);
  result(session, { ok: false, operation, error: reason });
}
function validPatch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PATCH_CHARS &&
    !/\b(cli_scope|container\.json|additional_mounts|mcp_servers|packages_(apt|npm)|credential|docker socket)\b/i.test(
      value,
    )
  );
}
function currentRevision(group: AgentGroup): string {
  return sha(readGroupPersona(path.join(GROUPS_DIR, group.folder)) ?? '');
}
function template(role: string, patch: string): string {
  return `# Factory-managed ${role}\n\nYou are a narrowly scoped ${role} agent created by Copilot. You have no authority to change your runtime configuration, permissions, mounts, credentials, packages, or destinations. Return findings to your parent.\n\n## Factory overlay\n\n${patch.trim()}\n`;
}

/** Owner-only enrollment primitive. It is deliberately not exposed to MCP. */
export function enrollFactoryManagedAgent(
  agentGroupId: string,
  templateId: string,
  ownerId: string | null = null,
): void {
  const group = getAgentGroup(agentGroupId);
  if (!group || !ENROLLABLE_TEMPLATES.has(templateId))
    throw new Error('Agent and approved factory template are required for enrollment');
  const revision = currentRevision(group);
  getDb()
    .prepare(
      `INSERT INTO factory_managed_agents
    (agent_group_id, factory_parent_group_id, template_id, instruction_revision, enrolled_at, enrolled_by_owner_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_group_id) DO UPDATE SET template_id=excluded.template_id, instruction_revision=excluded.instruction_revision,
      enrolled_at=excluded.enrolled_at, enrolled_by_owner_id=excluded.enrolled_by_owner_id`,
    )
    .run(agentGroupId, COPILOT_FACTORY_GROUP_ID, templateId, revision, new Date().toISOString(), ownerId);
  audit(COPILOT_FACTORY_GROUP_ID, agentGroupId, 'factory.enroll', 'allowed', { templateId }, revision);
}

function inventory(): Record<string, unknown>[] {
  const rows = getDb()
    .prepare(
      `SELECT m.*, g.name, c.provider, c.model, c.cli_scope
    FROM factory_managed_agents m JOIN agent_groups g ON g.id=m.agent_group_id
    LEFT JOIN container_configs c ON c.agent_group_id=g.id
    WHERE m.factory_parent_group_id=? ORDER BY g.name`,
    )
    .all(COPILOT_FACTORY_GROUP_ID) as Array<
    ManagedRow & { name: string; provider: string | null; model: string | null; cli_scope: string | null }
  >;
  return rows.map((r) => ({
    agent_group_id: r.agent_group_id,
    name: r.name,
    role: r.template_id,
    provider: r.provider,
    model: r.model,
    cli_scope: r.cli_scope,
    status: 'unknown',
    instructions_revision: r.instruction_revision,
    factory_parent_group_id: r.factory_parent_group_id,
  }));
}

function createChild(session: Session, content: Record<string, unknown>): void {
  const name = typeof content.name === 'string' ? content.name : '';
  const role = typeof content.role === 'string' ? content.role : '';
  const model = typeof content.model === 'string' ? content.model : '';
  const patch = content.instructions_patch === undefined ? '' : content.instructions_patch;
  if (
    !name ||
    !ROLES.has(role) ||
    !LOCAL_MODELS.has(model) ||
    !validPatch(patch) ||
    Object.keys(content).some(
      (k) => !['action', 'requestId', 'name', 'role', 'model', 'instructions_patch'].includes(k),
    )
  ) {
    return deny(
      session,
      'factory.create_local_agent',
      content,
      'Request must use an approved role/model and bounded instructions_patch only.',
    );
  }
  const localName = normalizeName(name);
  if (getDestinationByName(session.agent_group_id, localName))
    return deny(session, 'factory.create_local_agent', content, 'Destination name already exists.');
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) folder = `${localName}-${suffix++}`;
  const resolved = path.resolve(GROUPS_DIR, folder);
  if (!resolved.startsWith(path.resolve(GROUPS_DIR) + path.sep))
    return deny(session, 'factory.create_local_agent', content, 'Invalid agent name.');
  const now = new Date().toISOString();
  const id = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: now };
  getDb().transaction(() => {
    createAgentGroup(group);
    initGroupFilesystem(group, { instructions: template(role, patch), provider: 'openai-compatible' });
    updateContainerConfigScalars(id, { model, cli_scope: 'disabled' });
    createDestination({
      agent_group_id: session.agent_group_id,
      local_name: localName,
      target_type: 'agent',
      target_id: id,
      created_at: now,
    });
    createDestination({
      agent_group_id: id,
      local_name: 'parent',
      target_type: 'agent',
      target_id: session.agent_group_id,
      created_at: now,
    });
    const revision = currentRevision(group);
    getDb()
      .prepare(
        `INSERT INTO factory_managed_agents (agent_group_id, factory_parent_group_id, template_id, instruction_revision, enrolled_at, enrolled_by_owner_id) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, COPILOT_FACTORY_GROUP_ID, role, revision, now);
    audit(session.agent_group_id, id, 'factory.create_local_agent', 'allowed', content, revision);
  })();
  writeDestinations(session.agent_group_id, session.id);
  result(session, {
    ok: true,
    operation: 'factory.create_local_agent',
    agent_group_id: id,
    name: localName,
    role,
    model,
    cli_scope: 'disabled',
  });
}

function updateInstructions(session: Session, content: Record<string, unknown>): void {
  const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const expected = typeof content.expected_revision === 'string' ? content.expected_revision : '';
  const patch = content.instructions_patch;
  const row = managed(id);
  const group = row && getAgentGroup(id);
  if (!row || !group)
    return deny(session, 'factory.update_instructions', content, 'Managed agent not found.', id || null);
  if (!validPatch(patch))
    return deny(
      session,
      'factory.update_instructions',
      content,
      'instructions_patch is invalid or contains prohibited directives.',
      id,
    );
  const current = currentRevision(group);
  if (expected !== current || row.instruction_revision !== current)
    return deny(session, 'factory.update_instructions', content, 'Instruction revision is stale.', id);
  const next = template(row.template_id, patch);
  const file = path.join(GROUPS_DIR, group.folder, PERSONA_PREPEND_FILE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, next, { mode: 0o600 });
  fs.renameSync(temp, file);
  const revision = sha(next.trim());
  getDb().prepare('UPDATE factory_managed_agents SET instruction_revision=? WHERE agent_group_id=?').run(revision, id);
  const restarted = restartAgentGroupContainers(id, 'factory instruction update', 'Factory instructions were updated.');
  audit(session.agent_group_id, id, 'factory.update_instructions', 'allowed', content, revision);
  result(session, {
    ok: true,
    operation: 'factory.update_instructions',
    agent_group_id: id,
    instructions_revision: revision,
    restarted,
  });
}

async function requestCapability(session: Session, content: Record<string, unknown>): Promise<void> {
  const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const category = typeof content.category === 'string' ? content.category : '';
  const reason = typeof content.reason === 'string' ? content.reason : '';
  const target = typeof content.target === 'string' ? content.target : '';
  if (!managed(id))
    return deny(session, 'factory.request_capability_change', content, 'Managed agent not found.', id || null);
  if (!CAPABILITIES.has(category) || !reason || !target || reason.length > 2_000 || target.length > 1_000)
    return deny(session, 'factory.request_capability_change', content, 'Invalid capability request.', id);
  if (
    category === 'access_control' ||
    /(^|\W)(global|host shell|docker socket|main merge|delete)(\W|$)/i.test(`${target} ${reason}`)
  )
    return deny(
      session,
      'factory.request_capability_change',
      content,
      'This capability is immutable-denied by factory policy.',
      id,
    );
  await requestApproval({
    session,
    agentName: 'Copilot factory',
    action: 'factory_capability_change',
    payload: { target_group_id: id, category, reason, target },
    title: 'Copilot factory escalation',
    question: `Copilot requests ${category} for ${id}: ${reason}\nTarget: ${target}\nNo change will be made by this approval.`,
  });
  audit(session.agent_group_id, id, 'factory.request_capability_change', 'held', content);
  result(session, { ok: true, operation: 'factory.request_capability_change', status: 'pending_owner_approval' });
}

function wireAgentChannel(session: Session, content: Record<string, unknown>): void {
  const operation = 'factory.wire_agent_channel';
  const target = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const platformId = validateDiscordChannel(content.channel_type, content.platform_id);
  if (
    !target ||
    !platformId ||
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'agent_group_id', 'channel_type', 'platform_id'].includes(key),
    )
  ) {
    return deny(
      session,
      operation,
      content,
      'Use an enrolled agent and canonical Discord server channel ID.',
      target || null,
    );
  }
  if (!managed(target)) return deny(session, operation, content, 'Managed agent not found.', target);
  if (!hasChannelGrant(session, target, platformId))
    return deny(session, operation, content, 'Capability denied for this descendant and Discord channel.', target);

  const existing = channelWiring(target, 'discord', platformId);
  if (existing) {
    audit(session.agent_group_id, target, operation, 'idempotent', content);
    return result(session, {
      ok: true,
      operation,
      ...wirePayload(existing),
      projected_sessions: projectDestinations(target),
    });
  }
  const occupied = getDb()
    .prepare(
      `SELECT agent_group_id FROM factory_channel_wirings
       WHERE channel_type=? AND platform_id=? AND revoked_at IS NULL LIMIT 1`,
    )
    .get('discord', platformId) as { agent_group_id: string } | undefined;
  if (occupied)
    return deny(session, operation, content, 'This Discord channel already has a factory-managed responder.', target);

  let messagingGroup = getMessagingGroupByPlatform('discord', platformId, 'discord');
  const createdMessagingGroup = !messagingGroup;
  if (!messagingGroup) {
    messagingGroup = {
      id: crypto.randomUUID(),
      channel_type: 'discord',
      platform_id: platformId,
      instance: 'discord',
      name: getAgentGroup(target)?.name ?? null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
  } else if (messagingGroup.is_group !== 1 || messagingGroup.unknown_sender_policy !== 'strict') {
    return deny(
      session,
      operation,
      content,
      'Existing Discord channel is not a compatible strict server-channel group.',
      target,
    );
  }

  // A pre-existing wiring or reply destination was not created by this
  // factory path. Refuse to take it over rather than mutating unrelated config.
  if (getMessagingGroupAgents(messagingGroup.id).length > 0)
    return deny(session, operation, content, 'This Discord channel already has a responder.', target);
  if (getDestinationByTarget(target, 'channel', messagingGroup.id))
    return deny(session, operation, content, 'Target has a pre-existing destination for this channel.', target);

  const now = new Date().toISOString();
  const destinationLocalName = localChannelName(target);
  const wiring: FactoryChannelWiring = {
    wiring_id: crypto.randomUUID(),
    factory_parent_group_id: session.agent_group_id,
    agent_group_id: target,
    channel_type: 'discord',
    platform_id: platformId,
    messaging_group_id: messagingGroup.id,
    destination_local_name: destinationLocalName,
    created_messaging_group: createdMessagingGroup ? 1 : 0,
    policy_json: JSON.stringify(FACTORY_CHANNEL_POLICY),
    created_at: now,
    revoked_at: null,
  };
  const route: MessagingGroupAgent = {
    id: crypto.randomUUID(),
    messaging_group_id: messagingGroup.id,
    agent_group_id: target,
    engage_mode: FACTORY_CHANNEL_POLICY.engage_mode,
    engage_pattern: null,
    sender_scope: FACTORY_CHANNEL_POLICY.sender_scope,
    ignored_message_policy: FACTORY_CHANNEL_POLICY.ignored_message_policy,
    session_mode: FACTORY_CHANNEL_POLICY.session_mode,
    threads: FACTORY_CHANNEL_POLICY.threads,
    priority: FACTORY_CHANNEL_POLICY.priority,
    created_at: now,
  };
  getDb().transaction(() => {
    if (createdMessagingGroup) createMessagingGroup(messagingGroup!);
    getDb()
      .prepare(
        `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy,
          session_mode, threads, priority, created_at)
         VALUES (@id, @messaging_group_id, @agent_group_id, @engage_mode, @engage_pattern, @sender_scope,
          @ignored_message_policy, @session_mode, @threads, @priority, @created_at)`,
      )
      .run(route);
    createDestination({
      agent_group_id: target,
      local_name: destinationLocalName,
      target_type: 'channel',
      target_id: messagingGroup!.id,
      created_at: now,
    });
    getDb()
      .prepare(
        `INSERT INTO factory_channel_wirings
         (wiring_id, factory_parent_group_id, agent_group_id, channel_type, platform_id, messaging_group_id,
          destination_local_name, created_messaging_group, policy_json, created_at)
         VALUES (@wiring_id, @factory_parent_group_id, @agent_group_id, @channel_type, @platform_id, @messaging_group_id,
          @destination_local_name, @created_messaging_group, @policy_json, @created_at)`,
      )
      .run(wiring);
  })();
  const projected = projectDestinations(target);
  audit(session.agent_group_id, target, operation, 'allowed', content);
  result(session, { ok: true, operation, ...wirePayload(wiring), projected_sessions: projected });
}

function listChannelWirings(session: Session, content: Record<string, unknown>): void {
  const operation = 'factory.list_channel_wirings';
  const target =
    content.agent_group_id === undefined
      ? undefined
      : typeof content.agent_group_id === 'string'
        ? content.agent_group_id
        : '';
  if (target === '') return deny(session, operation, content, 'agent_group_id must be a string when supplied.');
  if (target && !managed(target)) return deny(session, operation, content, 'Managed agent not found.', target);
  const rows = getDb()
    .prepare(
      `SELECT * FROM factory_channel_wirings
       WHERE factory_parent_group_id=? AND revoked_at IS NULL ${target ? 'AND agent_group_id=?' : ''}
       ORDER BY created_at`,
    )
    .all(...(target ? [session.agent_group_id, target] : [session.agent_group_id])) as FactoryChannelWiring[];
  audit(session.agent_group_id, target ?? null, operation, 'allowed', content);
  result(session, { ok: true, operation, wirings: rows.map(wirePayload) });
}

function unwireAgentChannel(session: Session, content: Record<string, unknown>): void {
  const operation = 'factory.unwire_agent_channel';
  const target = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const platformId = validateDiscordChannel(content.channel_type, content.platform_id);
  if (!target || !platformId)
    return deny(
      session,
      operation,
      content,
      'Use an enrolled agent and canonical Discord server channel ID.',
      target || null,
    );
  if (!managed(target)) return deny(session, operation, content, 'Managed agent not found.', target);
  if (!hasChannelGrant(session, target, platformId))
    return deny(session, operation, content, 'Capability denied for this descendant and Discord channel.', target);
  const wiring = channelWiring(target, 'discord', platformId);
  if (!wiring) {
    audit(session.agent_group_id, target, operation, 'idempotent', content);
    return result(session, {
      ok: true,
      operation,
      agent_group_id: target,
      channel_type: 'discord',
      platform_id: platformId,
      status: 'unwired',
    });
  }
  getDb().transaction(() => {
    getDb()
      .prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id=? AND agent_group_id=?')
      .run(wiring.messaging_group_id, target);
    const destination = getDestinationByName(target, wiring.destination_local_name);
    if (destination?.target_type === 'channel' && destination.target_id === wiring.messaging_group_id)
      deleteDestination(target, wiring.destination_local_name);
    getDb()
      .prepare('UPDATE factory_channel_wirings SET revoked_at=? WHERE wiring_id=?')
      .run(new Date().toISOString(), wiring.wiring_id);
    if (
      wiring.created_messaging_group === 1 &&
      wiring.messaging_group_id &&
      getMessagingGroupAgents(wiring.messaging_group_id).length === 0
    )
      getDb().prepare('DELETE FROM messaging_groups WHERE id=?').run(wiring.messaging_group_id);
  })();
  const projected = projectDestinations(target);
  audit(session.agent_group_id, target, operation, 'allowed', content);
  result(session, {
    ok: true,
    operation,
    agent_group_id: target,
    channel_type: 'discord',
    platform_id: platformId,
    status: 'unwired',
    projected_sessions: projected,
  });
}

export async function handleFactoryAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const operation = typeof content.action === 'string' ? content.action : 'factory.unknown';
  // Generic descendants use the same familiar Factory read names, but their
  // visibility is derived from the live provisioning tree. Copilot's legacy
  // enrolled singleton inventory remains unchanged below.
  if (!isCopilot(session)) {
    const { getProvisionedAgentSummary, listProvisionedChildren } = await import('./provisioning.js');
    if (operation === 'factory.list_agents') {
      const response = listProvisionedChildren(session);
      audit(session.agent_group_id, null, operation, response.ok === true ? 'allowed' : 'denied', content);
      return result(session, { operation, ...response });
    }
    if (operation === 'factory.get_agent') {
      const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
      const response = await getProvisionedAgentSummary(session, id);
      audit(session.agent_group_id, id || null, operation, response.ok === true ? 'allowed' : 'denied', content);
      return result(session, { operation, ...response });
    }
    return deny(session, operation, content, 'Factory operation is not authorized for this generic parent.');
  }
  if (!hasTable(getDb(), 'factory_managed_agents'))
    return deny(session, operation, content, 'Factory storage is not installed.');
  if (operation === 'factory.list_agents') {
    audit(session.agent_group_id, null, operation, 'allowed', content);
    return result(session, { ok: true, agents: inventory() });
  }
  if (operation === 'factory.get_agent') {
    const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
    const row = managed(id);
    const group = row && getAgentGroup(id);
    const config = group && getContainerConfig(id);
    if (!row || !group || !config) return deny(session, operation, content, 'Managed agent not found.', id || null);
    audit(session.agent_group_id, id, operation, 'allowed', content, row.instruction_revision);
    return result(session, {
      ok: true,
      agent_group_id: id,
      name: group.name,
      role: row.template_id,
      provider: config.provider,
      model: config.model,
      cli_scope: config.cli_scope,
      capabilities:
        'factory-managed: no mounts, packages, MCP, credentials, deployment, GitHub, Docker, or configuration authority',
      instructions: readGroupPersona(path.join(GROUPS_DIR, group.folder)) ?? '',
      instructions_revision: row.instruction_revision,
    });
  }
  if (operation === 'factory.create_local_agent')
    return deny(
      session,
      operation,
      content,
      'Legacy direct creation is disabled; use factory_request_agent_provision.',
    );
  if (operation === 'factory.update_instructions') return updateInstructions(session, content);
  if (operation === 'factory.request_capability_change') return requestCapability(session, content);
  if (operation === 'factory.wire_agent_channel') return wireAgentChannel(session, content);
  if (operation === 'factory.list_channel_wirings') return listChannelWirings(session, content);
  if (operation === 'factory.unwire_agent_channel') return unwireAgentChannel(session, content);
  return deny(session, operation, content, 'Unknown factory operation.');
}

registerApprovalHandler('factory_capability_change', async ({ session, payload, approval }) => {
  const target = typeof payload.target_group_id === 'string' ? payload.target_group_id : null;
  audit(
    session.agent_group_id,
    target,
    'factory.request_capability_change',
    'approved_request_only',
    payload,
    undefined,
    approval.approval_id,
  );
  notifyAgent(session, 'Factory capability request was approved for review. No capability was applied automatically.');
});

// Approval resolution takes a separate code path for rejection, so this hook
// is the one place that records both approved and rejected escalation outcomes.
registerApprovalResolvedHandler(({ approval, session, outcome }) => {
  if (approval.action !== 'factory_capability_change') return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(approval.payload) as Record<string, unknown>;
  } catch {
    /* hashed empty payload is still safe */
  }
  const target = typeof payload.target_group_id === 'string' ? payload.target_group_id : null;
  audit(
    session.agent_group_id,
    target,
    'factory.request_capability_change',
    outcome,
    payload,
    undefined,
    approval.approval_id,
  );
});

export function logFactoryError(err: unknown): void {
  log.error('Factory action failed', { err });
}

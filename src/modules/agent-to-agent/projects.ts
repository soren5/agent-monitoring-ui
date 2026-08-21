/** Host-enforced shared project-channel factory. */
import crypto from 'crypto';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup, getAgentGroupByFolder, createAgentGroup } from '../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { notifyAgent } from '../approvals/index.js';
import { delegateGrant, findEffectiveGrant, revokeGrant } from './capabilities.js';
import { createDestination, deleteDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';

const DISCORD = /^discord:([1-9][0-9]{4,24}):([1-9][0-9]{4,24})$/;
const ROLES = new Set(['junior', 'codex', 'deepseek', 'local-coding', 'test', 'reviewer']);
const MODELS = new Set(['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b']);
const CHILD_ACTIONS = new Set([
  'create-child',
  'dispatch-child',
  'wire-descendant',
  'remove-descendant',
  'list-agents',
  'get-status',
]);
type Project = {
  project_id: string;
  project_parent_group_id: string;
  channel_type: string;
  platform_id: string;
  messaging_group_id: string;
  created_at: string;
  closed_at: string | null;
};
type ProjectAgent = {
  project_id: string;
  agent_group_id: string;
  parent_agent_group_id: string;
  role_id: string;
  alias: string;
  parent_local_name: string;
  child_parent_local_name: string;
  report_destination_local_name: string;
  created_at: string;
  removed_at: string | null;
};

const hash = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function audit(
  caller: string,
  projectId: string | null,
  target: string | null,
  operation: string,
  outcome: string,
  request: unknown,
) {
  getDb()
    .prepare(
      'INSERT INTO project_audit_events (created_at, caller_group_id, project_id, target_group_id, operation, outcome, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(new Date().toISOString(), caller, projectId, target, operation, outcome, hash(request));
}
function reply(session: Session, payload: Record<string, unknown>) {
  notifyAgent(session, `Project result: ${JSON.stringify(payload)}`);
}
function validDiscord(v: unknown): v is string {
  return typeof v === 'string' && DISCORD.test(v);
}
function projectById(id: string): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE project_id=? AND closed_at IS NULL').get(id) as
    | Project
    | undefined;
}
function projectForCaller(caller: string, projectId: string): Project | undefined {
  const p = projectById(projectId);
  if (!p) return undefined;
  if (p.project_parent_group_id === caller) return p;
  return child(projectId, caller) ? p : undefined;
}
function child(projectId: string, agentId: string): ProjectAgent | undefined {
  return getDb()
    .prepare('SELECT * FROM project_agents WHERE project_id=? AND agent_group_id=? AND removed_at IS NULL')
    .get(projectId, agentId) as ProjectAgent | undefined;
}
function isDescendant(projectId: string, ancestorId: string, candidateId: string): boolean {
  let current = child(projectId, candidateId);
  while (current) {
    if (current.parent_agent_group_id === ancestorId) return true;
    current = child(projectId, current.parent_agent_group_id);
  }
  return false;
}
function allowed(session: Session, p: Project, action: string): boolean {
  return !!findEffectiveGrant(session.agent_group_id, {
    resourceType: 'project',
    resourceId: p.project_id,
    action,
    constraints: { channel_type: p.channel_type, platform_id: p.platform_id },
  });
}
function projectDestinationName(agentId: string): string {
  let n = 'project';
  let i = 2;
  while (getDestinationByName(agentId, n)) n = `project-${i++}`;
  return n;
}
function subtree(projectId: string, rootId: string): ProjectAgent[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_agents WHERE project_id=? AND removed_at IS NULL')
    .all(projectId) as ProjectAgent[];
  const byParent = new Map<string, ProjectAgent[]>();
  for (const row of rows)
    byParent.set(row.parent_agent_group_id, [...(byParent.get(row.parent_agent_group_id) ?? []), row]);
  const result: ProjectAgent[] = [];
  const visit = (parent: string): void => {
    for (const row of byParent.get(parent) ?? []) {
      result.push(row);
      visit(row.agent_group_id);
    }
  };
  // `rootId` itself is a project row; include it and every live descendant.
  const root = rows.find((row) => row.agent_group_id === rootId);
  if (!root) return result;
  result.push(root);
  visit(rootId);
  return result;
}
function projectChildInstructions(role: string): string {
  return `# Project ${role} agent\n\nYou are a constrained child in one host-managed project. You may only perform work dispatched by your project parent, report through the project destination, and use capabilities the host has explicitly granted. You cannot change routing, credentials, mounts, packages, provider, permissions, or project membership.\n`;
}

/**
 * Create a project inside an existing host transaction. This has no
 * authorization surface: callers must already have performed owner approval.
 */
export function createProjectInTransaction(projectId: string, parentId: string, platformId: string): Project {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId) || !validDiscord(platformId))
    throw new Error('Invalid project ID or Discord server channel ID.');
  if (!getAgentGroup(parentId)) throw new Error('Project parent not found.');
  // A project channel is a new host-owned messaging group. Never absorb an
  // existing singleton or generic shared group merely because it has the
  // same Discord address.
  if (getMessagingGroupByPlatform('discord', platformId, 'discord'))
    throw new Error('Discord channel already has messaging wiring; project creation will not take it over.');
  if (
    getDb()
      .prepare('SELECT 1 FROM projects WHERE channel_type=? AND platform_id=? AND closed_at IS NULL')
      .get('discord', platformId)
  )
    throw new Error('Channel already belongs to an active project.');
  const mg: MessagingGroup = {
    id: crypto.randomUUID(),
    channel_type: 'discord',
    platform_id: platformId,
    instance: 'discord',
    name: projectId,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  };
  const p: Project = {
    project_id: projectId,
    project_parent_group_id: parentId,
    channel_type: 'discord',
    platform_id: platformId,
    messaging_group_id: mg.id,
    created_at: mg.created_at,
    closed_at: null,
  };
  createMessagingGroup(mg);
  getDb()
    .prepare(
      'INSERT INTO projects (project_id, project_parent_group_id, channel_type, platform_id, messaging_group_id, created_at) VALUES (@project_id, @project_parent_group_id, @channel_type, @platform_id, @messaging_group_id, @created_at)',
    )
    .run(p);
  // Parent is the sole ordinary inbound responder. Children are report-only.
  createMessagingGroupAgent({
    id: crypto.randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: parentId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    threads: 1,
    priority: 0,
    created_at: mg.created_at,
  });
  return p;
}

/** Owner-only compatibility primitive. New projects use approved provisioning. */
export function createProject(projectId: string, parentId: string, platformId: string): Project {
  const p = getDb().transaction(() => createProjectInTransaction(projectId, parentId, platformId))();
  for (const s of getDb().prepare('SELECT id FROM sessions WHERE agent_group_id=?').all(parentId) as Array<{
    id: string;
  }>) {
    writeDestinations(parentId, s.id);
  }
  return p;
}

function createChild(session: Session, p: Project, content: Record<string, unknown>): void {
  const name = typeof content.name === 'string' ? content.name : '';
  const role = typeof content.role === 'string' ? content.role : '';
  const model = typeof content.model === 'string' ? content.model : '';
  const requestedActions =
    Array.isArray(content.requested_actions) && content.requested_actions.every((x) => typeof x === 'string')
      ? [...new Set(content.requested_actions as string[])]
      : [];
  const alias = normalizeName(name);
  if (
    !allowed(session, p, 'create-child') ||
    !allowed(session, p, 'report-project-channel') ||
    (content.requested_actions !== undefined && !Array.isArray(content.requested_actions)) ||
    !requestedActions.every((action) => CHILD_ACTIONS.has(action) && allowed(session, p, action)) ||
    !name ||
    !ROLES.has(role) ||
    !MODELS.has(model) ||
    Object.keys(content).some(
      (k) => !['action', 'requestId', 'project_id', 'name', 'role', 'model', 'requested_actions'].includes(k),
    )
  ) {
    audit(session.agent_group_id, p.project_id, null, 'project.create_child', 'denied', content);
    return reply(session, { ok: false, error: 'Project child creation denied or invalid.' });
  }
  if (
    getDb()
      .prepare('SELECT 1 FROM project_agents WHERE project_id=? AND alias=? AND removed_at IS NULL')
      .get(p.project_id, alias)
  ) {
    audit(session.agent_group_id, p.project_id, null, 'project.create_child', 'denied', content);
    return reply(session, { ok: false, error: 'Project alias already exists.' });
  }
  let folder = `${normalizeName(p.project_id)}-${alias}`;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) folder = `${normalizeName(p.project_id)}-${alias}-${suffix++}`;
  if (!path.resolve(GROUPS_DIR, folder).startsWith(path.resolve(GROUPS_DIR) + path.sep))
    return reply(session, { ok: false, error: 'Invalid child name.' });
  const now = new Date().toISOString();
  const id = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: now };
  const parentLocal = alias;
  const childParent = 'parent';
  const report = projectDestinationName(id);
  getDb().transaction(() => {
    createAgentGroup(group);
    initGroupFilesystem(group, { instructions: projectChildInstructions(role), provider: 'openai-compatible' });
    updateContainerConfigScalars(id, { model, cli_scope: 'disabled' });
    createDestination({
      agent_group_id: session.agent_group_id,
      local_name: parentLocal,
      target_type: 'agent',
      target_id: id,
      created_at: now,
    });
    createDestination({
      agent_group_id: id,
      local_name: childParent,
      target_type: 'agent',
      target_id: session.agent_group_id,
      created_at: now,
    });
    createDestination({
      agent_group_id: id,
      local_name: report,
      target_type: 'channel',
      target_id: p.messaging_group_id,
      created_at: now,
    });
    getDb()
      .prepare(
        'INSERT INTO project_agents (project_id, agent_group_id, parent_agent_group_id, role_id, alias, parent_local_name, child_parent_local_name, report_destination_local_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.project_id, id, session.agent_group_id, role, alias, parentLocal, childParent, report, now);
  })();
  // A zero-ambient-capability child gets only a derived project report grant.
  // This is deliberately not best-effort: the parent must possess the
  // capability it is attenuating before the host creates the child.
  delegateGrant(session.agent_group_id, id, {
    resourceType: 'project',
    resourceId: p.project_id,
    action: 'report-project-channel',
    constraints: { channel_type: p.channel_type, platform_id: p.platform_id },
  });
  for (const action of requestedActions) {
    delegateGrant(session.agent_group_id, id, {
      resourceType: 'project',
      resourceId: p.project_id,
      action,
      constraints: { channel_type: p.channel_type, platform_id: p.platform_id },
    });
  }
  resolveSession(id, p.messaging_group_id, null, 'shared');
  writeDestinations(session.agent_group_id, session.id);
  for (const s of getDb().prepare('SELECT id FROM sessions WHERE agent_group_id=?').all(id) as Array<{ id: string }>)
    writeDestinations(id, s.id);
  audit(session.agent_group_id, p.project_id, id, 'project.create_child', 'allowed', content);
  reply(session, {
    ok: true,
    operation: 'project.create_child',
    project_id: p.project_id,
    agent_group_id: id,
    alias,
    role,
    model,
    delegated_actions: requestedActions,
  });
}

async function dispatch(session: Session, p: Project, content: Record<string, unknown>): Promise<void> {
  const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const task = typeof content.task === 'string' ? content.task : '';
  if (
    !allowed(session, p, 'dispatch-child') ||
    !isDescendant(p.project_id, session.agent_group_id, id) ||
    !task ||
    task.length > 12000
  ) {
    audit(session.agent_group_id, p.project_id, id || null, 'project.dispatch_child', 'denied', content);
    return reply(session, { ok: false, error: 'Project dispatch denied.' });
  }
  const target = findSessionByAgentGroup(id);
  if (!target) return reply(session, { ok: false, error: 'Project child has no active session.' });
  writeSessionMessage(id, target.id, {
    id: `project-dispatch-${crypto.randomUUID()}`,
    kind: 'agent',
    timestamp: new Date().toISOString(),
    content: task,
    trigger: 1,
    sourceSessionId: session.id,
  });
  void wakeContainer(target);
  audit(session.agent_group_id, p.project_id, id, 'project.dispatch_child', 'allowed', content);
  reply(session, { ok: true, operation: 'project.dispatch_child', agent_group_id: id });
}

function wire(session: Session, p: Project, content: Record<string, unknown>): void {
  const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const c = child(p.project_id, id);
  if (!allowed(session, p, 'wire-descendant') || !c || !isDescendant(p.project_id, session.agent_group_id, id)) {
    audit(session.agent_group_id, p.project_id, id || null, 'project.wire_descendant', 'denied', content);
    return reply(session, { ok: false, error: 'Project wiring denied.' });
  }
  for (const s of getDb().prepare('SELECT id FROM sessions WHERE agent_group_id=?').all(id) as Array<{ id: string }>)
    writeDestinations(id, s.id);
  audit(session.agent_group_id, p.project_id, id, 'project.wire_descendant', 'idempotent', content);
  reply(session, { ok: true, operation: 'project.wire_descendant', agent_group_id: id, status: 'wired' });
}

function remove(session: Session, p: Project, content: Record<string, unknown>): void {
  const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
  const c = child(p.project_id, id);
  if (!allowed(session, p, 'remove-descendant') || !c || !isDescendant(p.project_id, session.agent_group_id, id)) {
    audit(session.agent_group_id, p.project_id, id || null, 'project.remove_descendant', 'denied', content);
    return reply(session, { ok: false, error: 'Project removal denied.' });
  }
  const removed = subtree(p.project_id, id);
  getDb().transaction(() => {
    for (const row of removed) {
      for (const [owner, name, target] of [
        [row.parent_agent_group_id, row.parent_local_name, row.agent_group_id],
        [row.agent_group_id, row.child_parent_local_name, row.parent_agent_group_id],
        [row.agent_group_id, row.report_destination_local_name, p.messaging_group_id],
      ] as const) {
        const d = getDestinationByName(owner, name);
        if (d?.target_id === target) deleteDestination(owner, name);
      }
      getDb()
        .prepare('UPDATE project_agents SET removed_at=? WHERE project_id=? AND agent_group_id=?')
        .run(new Date().toISOString(), p.project_id, row.agent_group_id);
      getDb()
        .prepare('DELETE FROM project_thread_bindings WHERE project_id=? AND agent_group_id=?')
        .run(p.project_id, row.agent_group_id);
    }
  });
  for (const row of removed) {
    for (const g of getDb()
      .prepare(
        'SELECT grant_id FROM capability_grants WHERE subject_agent_group_id=? AND resource_type=? AND resource_id=? AND revoked_at IS NULL',
      )
      .all(row.agent_group_id, 'project', p.project_id) as Array<{ grant_id: string }>)
      revokeGrant(g.grant_id, session.agent_group_id);
    for (const s of getDb().prepare('SELECT id FROM sessions WHERE agent_group_id=?').all(row.agent_group_id) as Array<{
      id: string;
    }>)
      writeDestinations(row.agent_group_id, s.id);
  }
  for (const s of getDb()
    .prepare('SELECT id FROM sessions WHERE agent_group_id=?')
    .all(session.agent_group_id) as Array<{ id: string }>)
    writeDestinations(session.agent_group_id, s.id);
  audit(session.agent_group_id, p.project_id, id, 'project.remove_descendant', 'allowed', content);
  reply(session, {
    ok: true,
    operation: 'project.remove_descendant',
    agent_group_id: id,
    removed_agent_group_ids: removed.map((row) => row.agent_group_id),
    status: 'removed',
  });
}

export async function handleProjectAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const operation = typeof content.action === 'string' ? content.action : 'project.unknown';
  const projectId = typeof content.project_id === 'string' ? content.project_id : '';
  const p = projectForCaller(session.agent_group_id, projectId);
  if (!hasTable(getDb(), 'projects') || !p) {
    audit(session.agent_group_id, projectId || null, null, operation, 'denied', content);
    return reply(session, { ok: false, error: 'Project not found or caller is not a live project member.' });
  }
  // Legacy project creation predates the owner-approved provisioning
  // contract. Keep existing project lifecycle operations available, but never
  // let this compatibility route materialize a new child without approval.
  if (operation === 'project.create_child') {
    audit(session.agent_group_id, p.project_id, null, operation, 'denied', content);
    return reply(session, {
      ok: false,
      error: 'Legacy project creation is disabled; use factory_request_agent_provision.',
    });
  }
  if (operation === 'project.dispatch_child') return dispatch(session, p, content);
  if (operation === 'project.wire_descendant') return wire(session, p, content);
  if (operation === 'project.remove_descendant') return remove(session, p, content);
  if (operation === 'project.list_agents') {
    if (!allowed(session, p, 'list-agents')) return reply(session, { ok: false, error: 'Project list denied.' });
    const rows = getDb()
      .prepare(
        'SELECT agent_group_id, parent_agent_group_id, role_id, alias, created_at FROM project_agents WHERE project_id=? AND removed_at IS NULL ORDER BY created_at',
      )
      .all(p.project_id) as Array<Record<string, unknown> & { agent_group_id: string }>;
    const visible =
      session.agent_group_id === p.project_parent_group_id
        ? rows
        : rows.filter((row) => isDescendant(p.project_id, session.agent_group_id, row.agent_group_id));
    audit(session.agent_group_id, p.project_id, null, operation, 'allowed', content);
    return reply(session, { ok: true, project_id: p.project_id, agents: visible });
  }
  if (operation === 'project.get_status') {
    const id = typeof content.agent_group_id === 'string' ? content.agent_group_id : '';
    if (!allowed(session, p, 'get-status') || !isDescendant(p.project_id, session.agent_group_id, id))
      return reply(session, { ok: false, error: 'Project status denied or child not found.' });
    const s = findSessionByAgentGroup(id);
    audit(session.agent_group_id, p.project_id, id, operation, 'allowed', content);
    return reply(session, { ok: true, agent_group_id: id, lifecycle: s?.container_status ?? 'no_active_session' });
  }
  audit(session.agent_group_id, p.project_id, null, operation, 'denied', content);
  return reply(session, { ok: false, error: 'Unknown project operation.' });
}

/** Router hook: select a single child for an exact alias or a thread binding. */
export function resolveProjectRecipient(
  messagingGroupId: string,
  text: string,
  threadId: string | null,
): string | undefined {
  if (!hasTable(getDb(), 'projects')) return undefined;
  const p = getDb()
    .prepare('SELECT * FROM projects WHERE messaging_group_id=? AND closed_at IS NULL')
    .get(messagingGroupId) as Project | undefined;
  if (!p) return undefined;
  if (threadId) {
    const b = getDb()
      .prepare('SELECT agent_group_id FROM project_thread_bindings WHERE project_id=? AND thread_id=?')
      .get(p.project_id, threadId) as { agent_group_id: string } | undefined;
    if (b && child(p.project_id, b.agent_group_id)) return b.agent_group_id;
  }
  const m = /^\s*@([a-zA-Z0-9_-]+)\b/.exec(text);
  if (!m) return undefined;
  const c = getDb()
    .prepare('SELECT * FROM project_agents WHERE project_id=? AND alias=? AND removed_at IS NULL')
    .get(p.project_id, normalizeName(m[1])) as ProjectAgent | undefined;
  if (!c) return undefined;
  if (threadId)
    getDb()
      .prepare(
        'INSERT INTO project_thread_bindings (project_id, thread_id, agent_group_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id,thread_id) DO UPDATE SET agent_group_id=excluded.agent_group_id, created_at=excluded.created_at',
      )
      .run(p.project_id, threadId, c.agent_group_id, new Date().toISOString());
  return c.agent_group_id;
}

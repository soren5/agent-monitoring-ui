/** Owner-approved, host-materialized autonomous agent provisioning. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { wakeContainer } from '../../container-runner.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import {
  deletePendingApproval,
  findSessionByAgentGroup,
  getPendingApprovalsByAction,
  getSession,
  getSessionsByAgentGroup,
} from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
} from '../approvals/index.js';
import { getAgentTemplate, templateRevision } from './agent-templates.js';
import { delegateGrant, findEffectiveGrant, issueRootGrant } from './capabilities.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { createRelation, getLiveRelation, removeRelationSubtree } from './relations.js';
import { log } from '../../log.js';
import { ensureChildWorktree, ensureWorktreesAllowlisted, mountChildWorktree } from './repository-worktree.js';
import { writeDestinations } from './write-destinations.js';
import { probeLocalModel } from './local-model-health.js';
import { createProjectInTransaction } from './projects.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';

const DISCORD = /^discord:([1-9][0-9]{4,24}):([1-9][0-9]{4,24})$/;
const ACTIONS = new Set([
  'create-child',
  'activate-child',
  'dispatch-child',
  'list-agents',
  'get-status',
  'run-smoke-test',
  'remove-child',
]);
const MAX_OVERLAY = 8_000;
const MAX_NAME = 64;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const SMOKE_TIMEOUT_MS = 2 * 60 * 1_000;
const REPOSITORY_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SMOKE_FIXTURES: Record<string, { prompt: string; maxOutputChars: number }> = {
  'basic-agent-message': {
    prompt: 'Host smoke test.',
    maxOutputChars: 128,
  },
};

type ProvisionRow = {
  request_id: string;
  parent_agent_group_id: string;
  project_id: string | null;
  project_bootstrap_id: string | null;
  template_id: string;
  template_revision: string;
  display_name: string;
  normalized_name: string;
  requested_actions_json: string;
  instruction_overlay: string;
  repository_id: string | null;
  repository_branch_prefix: string | null;
  channel_type: string | null;
  platform_id: string | null;
  channel_mode: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'provisioned' | 'failed';
  owner_approval_id: string | null;
  provisioned_child_group_id: string | null;
  failure_category: string | null;
  projection_state: 'ready' | 'pending';
  created_at: string;
  resolved_at: string | null;
};
type ProjectRow = {
  project_id: string;
  project_parent_group_id: string;
  channel_type: string;
  platform_id: string;
  messaging_group_id: string;
  closed_at: string | null;
};

const now = () => new Date().toISOString();

/**
 * Resolve the default-branch HEAD SHA for a repository, used as the base for an
 * isolated child worktree. Reads from the local worktree source (the
 * consolidated single repo) so it matches what `ensureChildWorktree` will pin.
 */
function defaultBranchSha(repositoryId: string): string {
  const { repositorySource } = require('./repository-worktree.js') as {
    repositorySource: (repositoryId: string) => string;
  };
  const source = repositorySource(repositoryId);
  const { execFileSync } = require('child_process') as typeof import('child_process');
  return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}
const hash = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

function audit(requestId: string | null, caller: string, operation: string, outcome: string, request: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO agent_provision_audit_events
       (created_at, request_id, caller_group_id, operation, outcome, request_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now(), requestId, caller, operation, outcome, hash(request));
}
function lifecycle(agentId: string, state: string, detail: Record<string, unknown> = {}): void {
  getDb()
    .prepare('INSERT INTO agent_lifecycle_events (created_at, agent_group_id, state, detail_json) VALUES (?, ?, ?, ?)')
    .run(now(), agentId, state, JSON.stringify(detail));
}
function latestLifecycle(agentId: string): { state: string; created_at: string } | undefined {
  return getDb()
    .prepare('SELECT state, created_at FROM agent_lifecycle_events WHERE agent_group_id=? ORDER BY id DESC LIMIT 1')
    .get(agentId) as { state: string; created_at: string } | undefined;
}
function answer(session: Session, payload: Record<string, unknown>): void {
  notifyAgent(session, `Provisioning result: ${JSON.stringify(payload)}`);
}
function validOverlay(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= MAX_OVERLAY &&
    !/\b(cli_scope|container\.json|additional_mounts|mcp_servers|packages_(apt|npm)|credential|docker|host shell)\b/i.test(
      v,
    )
  );
}
function row(id: string): ProvisionRow | undefined {
  return getDb().prepare('SELECT * FROM agent_provision_requests WHERE request_id=?').get(id) as
    | ProvisionRow
    | undefined;
}
function directChildName(parentId: string, name: string): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM agent_provision_requests WHERE parent_agent_group_id=? AND normalized_name=? AND state IN ('pending','approved','provisioned')`,
    )
    .get(parentId, name);
}
function parentFolder(name: string): string {
  let folder = name;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) folder = `${name}-${suffix++}`;
  return folder;
}
function provisionedContract(agentGroupId: string): ProvisionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM agent_provision_requests WHERE provisioned_child_group_id=? AND state='provisioned'")
    .get(agentGroupId) as ProvisionRow | undefined;
}
function liveProject(projectId: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE project_id=? AND closed_at IS NULL').get(projectId) as
    | ProjectRow
    | undefined;
}
function parentBelongsToProject(parentId: string, project: ProjectRow): boolean {
  return (
    project.project_parent_group_id === parentId ||
    !!getDb()
      .prepare('SELECT 1 FROM project_agents WHERE project_id=? AND agent_group_id=? AND removed_at IS NULL')
      .get(project.project_id, parentId)
  );
}
/** A provisioned parent may only request children within its frozen template ceiling. */
function parentCanProvision(parentId: string, requestedActions: string[]): boolean {
  const relation = getLiveRelation(parentId);
  // A root is owner-approved at every child request. It has no ambient
  // descendant capability, but may begin a bounded hierarchy.
  if (!relation) return true;
  const contract = provisionedContract(parentId);
  const template = contract && getAgentTemplate(contract.template_id);
  return (
    !!template &&
    relation.depth < template.maxDescendantDepth &&
    template.capabilityActions.includes('create-child') &&
    requestedActions.every((action) => template.capabilityActions.includes(action))
  );
}
type ProvisionPayload = {
  projectId: string | null;
  projectBootstrapId: string | null;
  projectBootstrapPlatformId: string | null;
  templateId: string;
  displayName: string;
  normalizedName: string;
  actions: string[];
  overlay: string;
  repositoryId: string | null;
  repositoryBranchPrefix: string | null;
  channelType: string | null;
  platformId: string | null;
  channelMode: string | null;
};
type ProvisionPayloadResult = { payload: ProvisionPayload } | { error: string };

function requestPayload(content: Record<string, unknown>, session: Session): ProvisionPayloadResult {
  if (
    !Object.keys(content).every((key) =>
      [
        'action',
        'requestId',
        'template_id',
        'display_name',
        'requested_actions',
        'instruction_overlay',
        'project_id',
        'project_bootstrap',
        'repository_id',
        'repository_branch_prefix',
        'channel_binding',
      ].includes(key),
    )
  )
    return { error: 'Unsupported provisioning field.' };
  const templateId = typeof content.template_id === 'string' ? content.template_id : '';
  const displayName = typeof content.display_name === 'string' ? content.display_name.trim() : '';
  const normalizedName = normalizeName(displayName);
  const actions =
    Array.isArray(content.requested_actions) && content.requested_actions.every((x) => typeof x === 'string')
      ? [...new Set(content.requested_actions as string[])]
      : [];
  const overlay = content.instruction_overlay === undefined ? '' : content.instruction_overlay;
  const projectId = typeof content.project_id === 'string' ? content.project_id : null;
  const bootstrap = content.project_bootstrap;
  const bootstrapObject =
    bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
      ? (bootstrap as Record<string, unknown>)
      : undefined;
  const projectBootstrapId = typeof bootstrapObject?.project_id === 'string' ? bootstrapObject.project_id : null;
  const bootstrapPlatformId = typeof bootstrapObject?.platform_id === 'string' ? bootstrapObject.platform_id : null;
  const repositoryId = typeof content.repository_id === 'string' ? content.repository_id : null;
  const repositoryBranchPrefix =
    typeof content.repository_branch_prefix === 'string' ? content.repository_branch_prefix.trim() : null;
  const channel = content.channel_binding;
  const channelObject =
    channel && typeof channel === 'object' && !Array.isArray(channel)
      ? (channel as Record<string, unknown>)
      : undefined;
  const channelType = channelObject?.channel_type === 'discord' ? 'discord' : null;
  const platformId = channelType && typeof channelObject?.platform_id === 'string' ? channelObject.platform_id : null;
  const channelMode = typeof channelObject?.mode === 'string' ? channelObject.mode : null;
  const template = getAgentTemplate(templateId);
  const legalModes = template?.channelModes ?? [];
  const parentRelation = getLiveRelation(session.agent_group_id);
  if (!getAgentGroup(session.agent_group_id)) return { error: 'Calling agent is unavailable.' };
  if (!template) return { error: 'Unknown template_id.' };
  if (!displayName || displayName.length > MAX_NAME || !normalizedName)
    return { error: `display_name is required and must be at most ${MAX_NAME} characters.` };
  if (!validOverlay(overlay))
    return { error: 'instruction_overlay is invalid or contains a forbidden runtime boundary.' };
  if (content.requested_actions !== undefined && !Array.isArray(content.requested_actions))
    return { error: 'requested_actions must be an array.' };
  if (!actions.every((action) => ACTIONS.has(action)))
    return { error: 'requested_actions contains an unsupported action.' };
  if (!parentCanProvision(session.agent_group_id, actions))
    return { error: "requested_actions exceeds the parent's live template authority." };
  if (repositoryId !== null && !REPOSITORY_ID.test(repositoryId))
    return { error: 'repository_id must be owner/repository.' };
  if (repositoryBranchPrefix !== null) {
    if (!repositoryId) return { error: 'repository_branch_prefix requires repository_id.' };
    const bad = /[\s\\~^:?*\[@{]|\.[.]|^\.|^\/|\.lock$|[-.]$/.test(repositoryBranchPrefix);
    if (!repositoryBranchPrefix || repositoryBranchPrefix.length > 128 || bad || repositoryBranchPrefix.startsWith('-'))
      return { error: 'repository_branch_prefix is not a valid branch prefix.' };
  }
  if (bootstrap !== undefined) {
    if (!bootstrapObject || !Object.keys(bootstrapObject).every((key) => ['project_id', 'platform_id'].includes(key)))
      return { error: 'project_bootstrap must contain only project_id and platform_id.' };
    if (!projectBootstrapId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectBootstrapId))
      return { error: 'project_bootstrap.project_id must be a lowercase slug.' };
    if (!bootstrapPlatformId || !DISCORD.test(bootstrapPlatformId))
      return { error: 'project_bootstrap.platform_id must be a canonical Discord server channel ID.' };
    if (templateId !== 'requirements-parent')
      return { error: 'project_bootstrap requires template_id requirements-parent.' };
    if (parentRelation) return { error: 'project_bootstrap may be requested only by a hierarchy root.' };
    if (projectId) return { error: 'project_id cannot be combined with project_bootstrap.' };
    if (channel !== undefined) return { error: 'channel_binding cannot be combined with project_bootstrap.' };
  }
  if (templateId === 'requirements-parent' && !projectBootstrapId)
    return { error: 'requirements-parent requires project_bootstrap.' };
  if (
    channelObject &&
    !Object.keys(channelObject).every((key) => ['channel_type', 'platform_id', 'mode'].includes(key))
  )
    return { error: 'channel_binding contains an unsupported field.' };
  if (channel !== undefined && (!channelType || !platformId || !DISCORD.test(platformId) || !channelMode))
    return { error: 'channel_binding must use a canonical Discord server channel ID and mode.' };
  if (channelMode && !legalModes.includes(channelMode as never))
    return { error: 'channel_binding mode is not allowed by the template.' };
  const project = projectId ? liveProject(projectId) : undefined;
  if (projectId && (!project || !parentBelongsToProject(session.agent_group_id, project)))
    return { error: "project_id is unavailable or outside the caller's project tree." };
  if (projectBootstrapId && liveProject(projectBootstrapId))
    return { error: 'project_bootstrap.project_id is already active.' };
  if (projectId && parentRelation?.project_id && parentRelation.project_id !== projectId)
    return { error: "project_id does not match the caller's project relation." };
  if (
    channelMode === 'project-report' || channelMode === 'project-alias'
      ? !project || channelType !== project.channel_type || platformId !== project.platform_id
      : channelMode === 'singleton'
        ? !channelType || !platformId
        : channelType !== null || platformId !== null || channelMode !== null
  )
    return { error: 'channel_binding does not match the project or template routing policy.' };
  return {
    payload: {
      projectId,
      projectBootstrapId,
      projectBootstrapPlatformId: bootstrapPlatformId,
      templateId,
      displayName,
      normalizedName,
      actions,
      overlay,
      repositoryId,
      repositoryBranchPrefix,
      channelType,
      platformId,
      channelMode,
    },
  };
}

export async function requestAgentProvision(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!hasTable(getDb(), 'agent_provision_requests'))
    return answer(session, { ok: false, error: 'Provisioning storage is not installed.' });
  const validation = requestPayload(content, session);
  if (!('payload' in validation)) {
    audit(null, session.agent_group_id, 'provision.request', 'denied', content);
    return answer(session, { ok: false, error: validation.error });
  }
  const parsed = validation.payload;
  if (directChildName(session.agent_group_id, parsed.normalizedName)) {
    audit(null, session.agent_group_id, 'provision.request', 'denied', content);
    return answer(session, { ok: false, error: 'display_name duplicates an active direct child.' });
  }
  const requestId = `prov-${crypto.randomUUID()}`;
  const template = getAgentTemplate(parsed.templateId)!;
  const createdAt = now();
  getDb()
    .prepare(
      `INSERT INTO agent_provision_requests
     (request_id, parent_agent_group_id, project_id, project_bootstrap_id, template_id, template_revision, display_name, normalized_name, requested_actions_json, instruction_overlay, repository_id, repository_branch_prefix, channel_type, platform_id, channel_mode, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      requestId,
      session.agent_group_id,
      parsed.projectId,
      parsed.projectBootstrapId,
      parsed.templateId,
      templateRevision(template),
      parsed.displayName,
      parsed.normalizedName,
      JSON.stringify(parsed.actions),
      parsed.overlay,
      parsed.repositoryId,
      parsed.repositoryBranchPrefix,
      parsed.projectBootstrapId ? 'discord' : parsed.channelType,
      parsed.projectBootstrapId ? parsed.projectBootstrapPlatformId : parsed.platformId,
      parsed.projectBootstrapId ? 'project-parent' : parsed.channelMode,
      createdAt,
    );
  audit(requestId, session.agent_group_id, 'provision.request', 'held', content);
  try {
    await requestApproval({
      session,
      agentName: getAgentGroup(session.agent_group_id)!.name,
      action: 'agent_provision',
      payload: { request_id: requestId },
      title: `Provision agent: ${parsed.displayName}`,
      question: `Approve constrained ${parsed.templateId} child "${parsed.displayName}" for ${getAgentGroup(session.agent_group_id)!.name}?${parsed.projectBootstrapId ? ` Create project ${parsed.projectBootstrapId} and bind its shared channel to ${parsed.projectBootstrapPlatformId}.` : parsed.platformId ? ` Bind ${parsed.channelMode} to ${parsed.platformId}.` : ''}`,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    });
  } catch (err) {
    getDb()
      .prepare(
        "UPDATE agent_provision_requests SET state='failed', failure_category='approval_delivery_failed', resolved_at=? WHERE request_id=? AND state='pending'",
      )
      .run(now(), requestId);
    audit(requestId, session.agent_group_id, 'provision.request', 'failed', {
      reason: err instanceof Error ? err.name : 'approval_delivery_error',
    });
    return answer(session, {
      ok: false,
      operation: 'provision.request',
      request_id: requestId,
      error: 'Owner approval could not be requested.',
    });
  }
  answer(session, {
    ok: true,
    operation: 'provision.request',
    request_id: requestId,
    status: 'pending_owner_approval',
  });
}

async function materialize(request: ProvisionRow, session: Session, approvalId: string): Promise<string> {
  const template = getAgentTemplate(request.template_id);
  if (!template || templateRevision(template) !== request.template_revision)
    throw new Error('Template is unavailable or changed since approval.');
  const parent = getAgentGroup(request.parent_agent_group_id);
  if (!parent) throw new Error('Provisioning parent no longer exists.');
  if (template.provider === 'openai-compatible') {
    const health = await probeLocalModel(template.allowedModels[0]);
    if (!health.ok) throw new Error(`Local model backend is unhealthy: ${health.category}.`);
  }
  const project = request.project_id ? liveProject(request.project_id) : undefined;
  if (request.project_id && (!project || !parentBelongsToProject(parent.id, project)))
    throw new Error('Project is unavailable or the parent is no longer a project member.');
  if ((request.channel_mode === 'project-report' || request.channel_mode === 'project-alias') && !project)
    throw new Error('A live matching project channel is required.');
  if (
    request.project_bootstrap_id &&
    (request.template_id !== 'requirements-parent' ||
      getLiveRelation(parent.id) ||
      !request.channel_type ||
      !request.platform_id ||
      !DISCORD.test(request.platform_id) ||
      liveProject(request.project_bootstrap_id))
  )
    throw new Error('The requested requirements project bootstrap is no longer valid.');
  if (
    request.channel_mode === 'singleton' &&
    (!request.channel_type ||
      !request.platform_id ||
      getMessagingGroupByPlatform(request.channel_type, request.platform_id, request.channel_type))
  )
    throw new Error('The requested singleton channel is unavailable or already wired.');
  const folder = parentFolder(request.normalized_name);
  const groupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = now();
  const group: AgentGroup = {
    id: groupId,
    name: request.display_name,
    folder,
    agent_provider: null,
    created_at: createdAt,
  };
  const singletonGroup: MessagingGroup | undefined =
    request.channel_mode === 'singleton' && request.channel_type && request.platform_id
      ? {
          id: crypto.randomUUID(),
          channel_type: request.channel_type,
          platform_id: request.platform_id,
          instance: request.channel_type,
          name: request.display_name,
          is_group: 1,
          unknown_sender_policy: 'strict',
          created_at: createdAt,
        }
      : undefined;
  try {
    getDb().transaction(() => {
      createAgentGroup(group);
      // Filesystem initialization is deliberately inside the durable unit. If
      // it throws, the SQL transaction rolls back and the catch below removes
      // only the newly-created, deterministic group directory.
      initGroupFilesystem(group, {
        instructions: `${template.instructionBase}\n\n${request.instruction_overlay}`.trim(),
        provider: template.provider,
      });
      updateContainerConfigScalars(groupId, {
        model: template.allowedModels[0],
        cli_scope: 'disabled',
        harness: template.harness ?? 'read-only',
      });
      const bootstrapProject = request.project_bootstrap_id
        ? createProjectInTransaction(request.project_bootstrap_id, groupId, request.platform_id!)
        : undefined;
      createRelation(parent.id, groupId, {
        projectId: bootstrapProject?.project_id ?? request.project_id,
        provisionRequestId: request.request_id,
      });
      createDestination({
        agent_group_id: parent.id,
        local_name: request.normalized_name,
        target_type: 'agent',
        target_id: groupId,
        created_at: createdAt,
      });
      if (singletonGroup) {
        createMessagingGroup(singletonGroup);
        createMessagingGroupAgent({
          id: crypto.randomUUID(),
          messaging_group_id: singletonGroup.id,
          agent_group_id: groupId,
          engage_mode: 'mention-sticky',
          engage_pattern: null,
          sender_scope: 'known',
          ignored_message_policy: 'drop',
          session_mode: 'per-thread',
          threads: 1,
          priority: 0,
          created_at: createdAt,
        });
      }
      if (project) {
        const reportLocalName = 'project';
        createDestination({
          agent_group_id: groupId,
          local_name: reportLocalName,
          target_type: 'channel',
          target_id: project.messaging_group_id,
          created_at: createdAt,
        });
        getDb()
          .prepare(
            `INSERT INTO project_agents
             (project_id, agent_group_id, parent_agent_group_id, role_id, alias, parent_local_name,
              child_parent_local_name, report_destination_local_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'parent', ?, ?)`,
          )
          .run(
            project.project_id,
            groupId,
            parent.id,
            template.id,
            request.normalized_name,
            request.normalized_name,
            reportLocalName,
            createdAt,
          );
      }
      createDestination({
        agent_group_id: groupId,
        local_name: 'parent',
        target_type: 'agent',
        target_id: parent.id,
        created_at: createdAt,
      });
      if (request.repository_id) {
        const rootParent = !getLiveRelation(parent.id);
        const parentPrefixes = new Map<string, string>();
        for (const action of template.repositoryActions) {
          // A parent's repository authority comes from its own grants,
          // whether it is a root or a descendant. When the parent declares a
          // target branch prefix in the provisioning request, that prefix is
          // passed as a constraint so `findEffectiveGrant` selects the exact
          // grant that authorizes it (a parent may hold several grants for the
          // same repository) instead of arbitrarily picking the first. A root
          // with no matching grant falls back to a derived per-child
          // namespace; a descendant without one fails delegation below.
          const requested = request.repository_branch_prefix;
          const parentGrant = findEffectiveGrant(parent.id, {
            resourceType: 'repository',
            resourceId: request.repository_id,
            action,
            ...(requested
              ? { constraints: action === 'pr-create' ? { head_prefix: requested } : { branch_prefix: requested } }
              : {}),
          });
          const constraints = parentGrant ? (JSON.parse(parentGrant.constraints_json) as Record<string, unknown>) : {};
          const parentPrefix =
            action === 'pr-create'
              ? typeof constraints.head_prefix === 'string'
                ? constraints.head_prefix
                : null
              : typeof constraints.branch_prefix === 'string'
                ? constraints.branch_prefix
                : null;
          const prefix = requested && parentGrant ? requested : (parentPrefix ?? `nanoclaw/${groupId}/`);
          // A nested child must be strictly narrower than its parent's branch
          // namespace; a root without grants derives its own namespace, and a
          // root WITH grants passes its exact prefix down unchanged.
          const childPrefix = rootParent ? prefix : `${prefix}${groupId}/`;
          parentPrefixes.set(action, childPrefix);
          const capability = {
            resourceType: 'repository',
            resourceId: request.repository_id,
            action,
            constraints: action === 'pr-create' ? { head_prefix: childPrefix } : { branch_prefix: childPrefix },
          };
          if (rootParent) issueRootGrant(groupId, capability, `approval:${approvalId}`);
          else delegateGrant(parent.id, groupId, capability);
        }
        getDb()
          .prepare(
            `INSERT INTO agent_repository_profiles
             (agent_group_id, repository_id, branch_prefix, head_prefix, allowed_actions_json, merge_policy, provision_request_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            groupId,
            request.repository_id,
            parentPrefixes.get('branch-write') ?? parentPrefixes.get('read') ?? `nanoclaw/${groupId}/`,
            parentPrefixes.get('pr-create') ?? `nanoclaw/${groupId}/`,
            JSON.stringify(template.repositoryActions),
            template.mergePolicy,
            request.request_id,
            createdAt,
          );
        // Provision an isolated writable worktree for the child. Pinned to the
        // repository's default-branch HEAD at materialization time (the
        // consolidated base); the child's dispatch pins the exact task base.
        // Non-fatal on infrastructure failure (e.g. worktree source missing):
        // the agent + grants still materialize, and the operator can add the
        // checkout out-of-band. The repo profile records intent regardless.
        try {
          ensureWorktreesAllowlisted();
          const baseSha = defaultBranchSha(request.repository_id);
          const worktreePath = ensureChildWorktree(groupId, request.repository_id, baseSha);
          mountChildWorktree(groupId, worktreePath);
        } catch (err) {
          log.warn('Isolated worktree provisioning failed; agent materialized without a local checkout', {
            agentGroupId: groupId,
            repositoryId: request.repository_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      for (const action of JSON.parse(request.requested_actions_json) as string[]) {
        // The owner approval is the root authority; each operation is still
        // restricted to this exact direct child.
        issueRootGrant(
          parent.id,
          { resourceType: 'factory-relation', resourceId: groupId, action },
          `approval:${approvalId}`,
        );
      }
      getDb()
        .prepare(
          `UPDATE agent_provision_requests SET state='provisioned', owner_approval_id=?, provisioned_child_group_id=?, resolved_at=? WHERE request_id=? AND state='pending'`,
        )
        .run(approvalId, groupId, now(), request.request_id);
    })();
  } catch (err) {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    throw err;
  }
  lifecycle(groupId, 'provisioned', { template_id: template.id, request_id: request.request_id });
  const { session: childSession } = resolveSession(groupId, null, null, 'agent-shared');
  try {
    for (const parentSession of getSessionsByAgentGroup(parent.id)) writeDestinations(parent.id, parentSession.id);
    writeDestinations(groupId, childSession.id);
  } catch (err) {
    // The durable destination records are correct; spawn will retry the
    // projection. Expose the temporary state rather than silently claiming a
    // fully wired child.
    getDb()
      .prepare("UPDATE agent_provision_requests SET projection_state='pending' WHERE request_id=?")
      .run(request.request_id);
    audit(request.request_id, parent.id, 'provision.project_destinations', 'pending', {
      error: err instanceof Error ? err.name : 'projection_error',
    });
  }
  return groupId;
}

registerApprovalHandler('agent_provision', async ({ session, payload, approval }) => {
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  const request = row(requestId);
  if (!request || request.parent_agent_group_id !== session.agent_group_id) return;
  if (request.state === 'provisioned') {
    return answer(session, {
      ok: true,
      operation: 'provision.materialize',
      request_id: requestId,
      agent_group_id: request.provisioned_child_group_id,
      status: 'provisioned',
    });
  }
  if (request.state !== 'pending') return;
  try {
    const childId = await materialize(request, session, approval.approval_id);
    audit(requestId, session.agent_group_id, 'provision.materialize', 'allowed', payload);
    answer(session, {
      ok: true,
      operation: 'provision.materialize',
      request_id: requestId,
      agent_group_id: childId,
      status: 'provisioned',
    });
  } catch (err) {
    getDb()
      .prepare(
        `UPDATE agent_provision_requests SET state='failed', failure_category='materialization_failed', resolved_at=? WHERE request_id=?`,
      )
      .run(now(), requestId);
    audit(requestId, session.agent_group_id, 'provision.materialize', 'failed', payload);
    answer(session, {
      ok: false,
      operation: 'provision.materialize',
      request_id: requestId,
      error: err instanceof Error ? err.message : 'Materialization failed.',
    });
  }
});

registerApprovalResolvedHandler(({ approval, session, outcome }) => {
  if (approval.action !== 'agent_provision' || outcome !== 'reject') return;
  let payload: { request_id?: string } = {};
  try {
    payload = JSON.parse(approval.payload) as { request_id?: string };
  } catch {
    return;
  }
  if (!payload.request_id) return;
  getDb()
    .prepare(
      `UPDATE agent_provision_requests SET state='rejected', resolved_at=? WHERE request_id=? AND state='pending'`,
    )
    .run(now(), payload.request_id);
  audit(payload.request_id, session.agent_group_id, 'provision.request', 'rejected', payload);
});

/** Host-sweep expiry for immutable pending provisioning contracts. */
export async function sweepExpiredProvisionApprovals(nowIso = now()): Promise<number> {
  const expired = getPendingApprovalsByAction('agent_provision').filter(
    (approval) => approval.status === 'pending' && !!approval.expires_at && approval.expires_at <= nowIso,
  );
  for (const approval of expired) {
    let payload: { request_id?: string } = {};
    try {
      payload = JSON.parse(approval.payload) as { request_id?: string };
    } catch {
      // A malformed opaque payload cannot authorize anything; remove only its pending card.
    }
    if (payload.request_id) {
      const request = row(payload.request_id);
      if (request?.state === 'pending') {
        getDb()
          .prepare(
            "UPDATE agent_provision_requests SET state='failed', failure_category='approval_expired', resolved_at=? WHERE request_id=?",
          )
          .run(nowIso, request.request_id);
        audit(request.request_id, request.parent_agent_group_id, 'provision.request', 'expired', {
          approval_id: approval.approval_id,
        });
      }
    }
    deletePendingApproval(approval.approval_id);
    const session = approval.session_id ? getSession(approval.session_id) : undefined;
    if (session)
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `provision-expired-${crypto.randomUUID()}`,
        kind: 'chat',
        timestamp: nowIso,
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: 'Your agent provisioning request expired before owner approval.',
          sender: 'system',
          senderId: 'system',
        }),
      });
  }
  return expired.length;
}

export async function handleProvisionAction(content: Record<string, unknown>, session: Session): Promise<void> {
  if (content.action === 'provision.request') return requestAgentProvision(content, session);
  if (content.action === 'provision.activate') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    const response = await activateProvisionedChild(session, child);
    return answer(session, { operation: 'provision.activate', child_agent_group_id: child, ...response });
  }
  if (content.action === 'provision.dispatch') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    const task = typeof content.task === 'string' ? content.task : '';
    const response = await dispatchProvisionedChild(session, child, task);
    return answer(session, { operation: 'provision.dispatch', child_agent_group_id: child, ...response });
  }
  if (content.action === 'provision.get_status') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    return answer(session, {
      operation: 'provision.get_status',
      child_agent_group_id: child,
      ...(await getProvisionedStatus(session, child)),
    });
  }
  if (content.action === 'provision.wake') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    const response = await wakeProvisionedChild(session, child);
    return answer(session, { operation: 'provision.wake', child_agent_group_id: child, ...response });
  }
  if (content.action === 'provision.smoke') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    const response = await runProvisionedSmokeTest(session, child);
    return answer(session, { operation: 'provision.smoke', child_agent_group_id: child, ...response });
  }
  if (content.action === 'provision.get_smoke') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    return answer(session, {
      operation: 'provision.get_smoke',
      child_agent_group_id: child,
      ...getProvisionedSmokeTest(session, child),
    });
  }
  if (content.action === 'provision.list_children') {
    return answer(session, { operation: 'provision.list_children', ...listProvisionedChildren(session) });
  }
  if (content.action === 'provision.remove') {
    const child = typeof content.child_agent_group_id === 'string' ? content.child_agent_group_id : '';
    return answer(session, {
      operation: 'provision.remove',
      child_agent_group_id: child,
      ...(await removeProvisionedChild(session, child)),
    });
  }
  answer(session, { ok: false, error: 'Unknown provisioning operation.' });
}

export async function activateProvisionedChild(
  parent: Session,
  childId: string,
): Promise<{ ok: boolean; error?: string }> {
  const relation = getLiveRelation(childId);
  if (
    !relation ||
    relation.parent_agent_group_id !== parent.agent_group_id ||
    !findEffectiveGrant(parent.agent_group_id, {
      resourceType: 'factory-relation',
      resourceId: childId,
      action: 'activate-child',
    })
  )
    return { ok: false, error: 'Child activation is not authorized.' };
  const { session } = resolveSession(childId, null, null, 'agent-shared');
  lifecycle(childId, 'ready', { activated_by: parent.agent_group_id });
  await wakeContainer(session);
  return { ok: true };
}

export async function dispatchProvisionedChild(
  parent: Session,
  childId: string,
  task: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!task || task.length > 12_000) return { ok: false, error: 'Task is invalid.' };
  const relation = getLiveRelation(childId);
  if (
    !relation ||
    relation.parent_agent_group_id !== parent.agent_group_id ||
    !findEffectiveGrant(parent.agent_group_id, {
      resourceType: 'factory-relation',
      resourceId: childId,
      action: 'dispatch-child',
    })
  )
    return { ok: false, error: 'Child dispatch is not authorized.' };
  const { session } = resolveSession(childId, null, null, 'agent-shared');
  writeSessionMessage(childId, session.id, {
    id: `dispatch-${crypto.randomUUID()}`,
    kind: 'agent',
    timestamp: now(),
    content: task,
    trigger: 1,
    sourceSessionId: parent.id,
  });
  lifecycle(childId, 'running', { dispatched_by: parent.agent_group_id });
  await wakeContainer(session);
  return { ok: true };
}

/** Redacted direct-child inventory; a parent never sees siblings or ancestors. */
export function listProvisionedChildren(parent: Session): Record<string, unknown> {
  const rows = getDb()
    .prepare(
      `SELECT r.child_agent_group_id, p.template_id, p.display_name, p.projection_state
       FROM agent_relations r JOIN agent_provision_requests p ON p.provisioned_child_group_id=r.child_agent_group_id
       WHERE r.parent_agent_group_id=? AND r.removed_at IS NULL AND p.state='provisioned'
       ORDER BY p.created_at`,
    )
    .all(parent.agent_group_id) as Array<{
    child_agent_group_id: string;
    template_id: string;
    display_name: string;
    projection_state: string;
  }>;
  const visible = rows.filter((child) =>
    findEffectiveGrant(parent.agent_group_id, {
      resourceType: 'factory-relation',
      resourceId: child.child_agent_group_id,
      action: 'list-agents',
    }),
  );
  return {
    ok: true,
    children: visible.map((child) => ({
      agent_group_id: child.child_agent_group_id,
      name: child.display_name,
      template_id: child.template_id,
      projection_state: child.projection_state,
    })),
  };
}

/**
 * Redacted generic Factory read model. This deliberately derives visibility
 * from the direct relation and status/list grants rather than legacy Factory
 * enrollment, agent names, or destinations.
 */
export async function getProvisionedAgentSummary(parent: Session, childId: string): Promise<Record<string, unknown>> {
  const relation = getLiveRelation(childId);
  if (
    !relation ||
    relation.parent_agent_group_id !== parent.agent_group_id ||
    (!hasChildCapability(parent, childId, 'get-status') && !hasChildCapability(parent, childId, 'list-agents'))
  )
    return { ok: false, error: 'Agent is not visible to this parent.' };
  const contract = provisionedContract(childId);
  const group = getAgentGroup(childId);
  if (!contract || !group) return { ok: true, status: 'not_provisioned' };
  const capabilityRows = getDb()
    .prepare(
      "SELECT actions_json FROM capability_grants WHERE subject_agent_group_id=? AND resource_type='factory-relation' AND resource_id=? AND revoked_at IS NULL",
    )
    .all(parent.agent_group_id, childId) as Array<{ actions_json: string }>;
  const management_actions = capabilityRows.flatMap((row) => {
    try {
      return JSON.parse(row.actions_json) as string[];
    } catch {
      return [];
    }
  });
  const repository = hasTable(getDb(), 'agent_repository_profiles')
    ? (getDb()
        .prepare(
          'SELECT repository_id, allowed_actions_json, merge_policy FROM agent_repository_profiles WHERE agent_group_id=?',
        )
        .get(childId) as { repository_id: string; allowed_actions_json: string; merge_policy: string } | undefined)
    : undefined;
  const routes = getDb()
    .prepare('SELECT target_type FROM agent_destinations WHERE agent_group_id=? ORDER BY target_type')
    .all(childId) as Array<{ target_type: string }>;
  return {
    ok: true,
    agent_group_id: childId,
    name: group.name,
    template_id: contract.template_id,
    template_revision: contract.template_revision,
    parent_agent_group_id: relation.parent_agent_group_id,
    project_id: relation.project_id,
    management_actions: [...new Set(management_actions)].sort(),
    repository: repository
      ? {
          id: repository.repository_id,
          actions: JSON.parse(repository.allowed_actions_json) as string[],
          merge_policy: repository.merge_policy,
        }
      : null,
    routing: { destination_types: [...new Set(routes.map((route) => route.target_type))].sort() },
    status: await getProvisionedStatus(parent, childId),
  };
}

/**
 * Removes only the caller's direct provisioned subtree. Durable identities and
 * audit history remain; live relations, derived grants, and contract-created
 * routes are revoked before a future host operation can use them.
 */
export async function removeProvisionedChild(parent: Session, childId: string): Promise<Record<string, unknown>> {
  if (!hasChildCapability(parent, childId, 'remove-child'))
    return { ok: false, error: 'Child removal is not authorized.' };
  const descendants = getDb()
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT child_agent_group_id FROM agent_relations WHERE child_agent_group_id=? AND removed_at IS NULL
         UNION ALL
         SELECT r.child_agent_group_id FROM agent_relations r JOIN subtree s ON r.parent_agent_group_id=s.id
         WHERE r.removed_at IS NULL
       ) SELECT id FROM subtree`,
    )
    .all(childId) as Array<{ id: string }>;
  if (!descendants.length) return { ok: false, error: 'Child is not live.' };
  const ids = descendants.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const singletonMessagingGroups = getDb()
    .prepare(
      `SELECT DISTINCT mga.messaging_group_id
       FROM messaging_group_agents mga
       WHERE mga.agent_group_id IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM projects p
           WHERE p.messaging_group_id=mga.messaging_group_id AND p.closed_at IS NULL
         )`,
    )
    .all(...ids) as Array<{ messaging_group_id: string }>;
  getDb().transaction(() => {
    removeRelationSubtree(parent.agent_group_id, childId);
    const removedAt = now();
    getDb()
      .prepare(
        `UPDATE capability_grants SET revoked_at=?
         WHERE revoked_at IS NULL AND (subject_agent_group_id IN (${placeholders}) OR resource_id IN (${placeholders}))`,
      )
      .run(removedAt, ...ids, ...ids);
    // Destinations created by provisioning only point to a removed agent or
    // belong to a removed agent. Project messaging groups are deliberately
    // retained because they are shared parent-first infrastructure.
    getDb()
      .prepare(
        `DELETE FROM agent_destinations
         WHERE agent_group_id IN (${placeholders}) OR (target_type='agent' AND target_id IN (${placeholders}))`,
      )
      .run(...ids, ...ids);
    getDb()
      .prepare(`DELETE FROM messaging_group_agents WHERE agent_group_id IN (${placeholders})`)
      .run(...ids);
    // A requirements parent is also an ordinary responder for its project
    // channel. Never remove a live project's shared infrastructure when that
    // parent (or a descendant) is revoked; only true singleton routes qualify.
    for (const group of singletonMessagingGroups) {
      const remaining = getDb()
        .prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE messaging_group_id=?')
        .get(group.messaging_group_id) as { n: number };
      if (remaining.n === 0) getDb().prepare('DELETE FROM messaging_groups WHERE id=?').run(group.messaging_group_id);
    }
    getDb()
      .prepare(
        `UPDATE project_agents SET removed_at=? WHERE agent_group_id IN (${placeholders}) AND removed_at IS NULL`,
      )
      .run(removedAt, ...ids);
  })();
  for (const id of ids) lifecycle(id, 'revoked', { revoked_by: parent.agent_group_id });
  audit(null, parent.agent_group_id, 'provision.remove', 'allowed', {
    child_agent_group_id: childId,
    removed: ids.length,
  });
  return { ok: true, removed_agent_group_ids: ids };
}

function hasChildCapability(parent: Session, childId: string, action: string): boolean {
  const relation = getLiveRelation(childId);
  return (
    !!relation &&
    relation.parent_agent_group_id === parent.agent_group_id &&
    !!findEffectiveGrant(parent.agent_group_id, {
      resourceType: 'factory-relation',
      resourceId: childId,
      action,
    })
  );
}

/** Redacted status is host evidence, never a leak of session/container internals. */
export async function getProvisionedStatus(parent: Session, childId: string): Promise<Record<string, unknown>> {
  if (!hasChildCapability(parent, childId, 'get-status'))
    return { ok: false, error: 'Child status is not authorized.' };
  const contract = provisionedContract(childId);
  const config = getContainerConfig(childId);
  const last = latestLifecycle(childId);
  const smoke = hasTable(getDb(), 'agent_smoke_test_results')
    ? (getDb()
        .prepare(
          'SELECT state, started_at, finished_at FROM agent_smoke_test_results WHERE agent_group_id=? ORDER BY started_at DESC LIMIT 1',
        )
        .get(childId) as Record<string, unknown> | undefined)
    : undefined;
  if (!contract || !config) return { ok: true, status: 'not_provisioned' };
  const localHealth =
    config.provider === 'openai-compatible' && config.model
      ? await probeLocalModel(config.model).catch(() => ({ ok: false as const, category: 'endpoint' as const }))
      : null;
  const status =
    contract.projection_state === 'pending'
      ? 'projection_pending'
      : localHealth && !localHealth.ok
        ? 'backend_unhealthy'
        : (last?.state ?? 'provisioned');
  return {
    ok: true,
    status,
    template_id: contract.template_id,
    template_revision: contract.template_revision,
    provider: config.provider,
    model: config.model,
    last_transition: last ? { state: last.state, at: last.created_at } : null,
    projection_state: contract.projection_state,
    backend_health: localHealth?.ok ? 'healthy' : localHealth ? localHealth.category : null,
    latest_smoke_test: smoke ?? null,
  };
}

/** Wake deliberately creates neither a session nor an audit record. */
export async function wakeProvisionedChild(parent: Session, childId: string): Promise<{ ok: boolean; error?: string }> {
  if (!hasChildCapability(parent, childId, 'activate-child'))
    return { ok: false, error: 'Child wake is not authorized.' };
  const childSession = findSessionByAgentGroup(childId);
  if (!childSession) return { ok: false, error: 'Child has no provisioned private session.' };
  await wakeContainer(childSession);
  return { ok: true };
}

export async function runProvisionedSmokeTest(parent: Session, childId: string): Promise<Record<string, unknown>> {
  if (!hasChildCapability(parent, childId, 'run-smoke-test'))
    return { ok: false, error: 'Child smoke test is not authorized.' };
  const contract = provisionedContract(childId);
  const template = contract && getAgentTemplate(contract.template_id);
  const fixture = template && SMOKE_FIXTURES[template.smokeTestId];
  if (!contract || !template || !fixture) return { ok: false, error: 'Child smoke fixture is unavailable.' };
  if (template.provider === 'openai-compatible') {
    const health = await probeLocalModel(template.allowedModels[0]);
    if (!health.ok) {
      lifecycle(childId, 'backend_unhealthy', { category: health.category, operation: 'provision.smoke' });
      audit(contract.request_id, parent.agent_group_id, 'provision.smoke', 'denied', { category: health.category });
      return { ok: false, error: 'Local model backend is unhealthy.', backend_health: health.category };
    }
  }
  const childSession = findSessionByAgentGroup(childId);
  if (!childSession) return { ok: false, error: 'Child has no provisioned private session.' };
  const smokeTestId = `smoke-${crypto.randomUUID()}`;
  const challenge = crypto.randomBytes(18).toString('base64url');
  const expectedResponse = `SMOKE_OK ${challenge}`;
  getDb()
    .prepare(
      "INSERT INTO agent_smoke_test_results (smoke_test_id, agent_group_id, fixture_id, state, expected_response_hash, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
    )
    .run(smokeTestId, childId, template.smokeTestId, hash(expectedResponse), now());
  audit(contract.request_id, parent.agent_group_id, 'provision.smoke', 'started', { fixture_id: template.smokeTestId });
  writeSessionMessage(childId, childSession.id, {
    id: `smoke-dispatch-${crypto.randomUUID()}`,
    kind: 'agent',
    timestamp: now(),
    content: `${fixture.prompt}\n\nUse your existing \`parent\` agent destination to send exactly this text and nothing else: ${expectedResponse}`,
    trigger: 1,
    sourceSessionId: parent.id,
  });
  lifecycle(childId, 'running', {
    smoke_test_id: smokeTestId,
    fixture_id: template.smokeTestId,
    max_output_chars: fixture.maxOutputChars,
  });
  await wakeContainer(childSession);
  return { ok: true, smoke_test_id: smokeTestId, state: 'running' };
}

/**
 * Host-only smoke completion. The delivery bridge invokes this before normal
 * a2a routing, so a successful challenge is never a model-asserted state nor
 * an unsolicited parent message. Only the current opaque challenge can pass.
 */
export function observeProvisionedSmokeResponse(
  sourceAgentGroupId: string,
  targetAgentGroupId: string | null,
  content: string,
): boolean {
  if (!targetAgentGroupId) return false;
  const relation = getLiveRelation(sourceAgentGroupId);
  if (!relation || relation.parent_agent_group_id !== targetAgentGroupId) return false;
  let text = '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    text = content.trim();
  }
  const smoke = getDb()
    .prepare(
      "SELECT smoke_test_id, fixture_id, expected_response_hash FROM agent_smoke_test_results WHERE agent_group_id=? AND state='running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(sourceAgentGroupId) as
    | { smoke_test_id: string; fixture_id: string; expected_response_hash: string | null }
    | undefined;
  if (!smoke) return false;
  const passed = !!smoke.expected_response_hash && hash(text) === smoke.expected_response_hash;
  getDb()
    .prepare(
      "UPDATE agent_smoke_test_results SET state=?, output_redacted=?, finished_at=? WHERE smoke_test_id=? AND state='running'",
    )
    .run(passed ? 'passed' : 'failed', passed ? 'SMOKE_OK' : 'invalid_response', now(), smoke.smoke_test_id);
  lifecycle(sourceAgentGroupId, passed ? 'smoke_passed' : 'smoke_failed', { smoke_test_id: smoke.smoke_test_id });
  const contract = provisionedContract(sourceAgentGroupId);
  audit(contract?.request_id ?? null, sourceAgentGroupId, 'provision.smoke', passed ? 'passed' : 'failed', {
    fixture_id: smoke.fixture_id,
  });
  return true;
}

/** Host sweep finalizes tests that never return a valid response. */
export function sweepProvisionedSmokeTests(nowIso = now()): number {
  if (!hasTable(getDb(), 'agent_smoke_test_results')) return 0;
  const cutoff = new Date(Date.parse(nowIso) - SMOKE_TIMEOUT_MS).toISOString();
  const expired = getDb()
    .prepare(
      "SELECT smoke_test_id, agent_group_id FROM agent_smoke_test_results WHERE state='running' AND started_at<=?",
    )
    .all(cutoff) as Array<{ smoke_test_id: string; agent_group_id: string }>;
  for (const smoke of expired) {
    getDb()
      .prepare(
        "UPDATE agent_smoke_test_results SET state='timeout', output_redacted='timeout', finished_at=? WHERE smoke_test_id=? AND state='running'",
      )
      .run(nowIso, smoke.smoke_test_id);
    lifecycle(smoke.agent_group_id, 'smoke_timeout', { smoke_test_id: smoke.smoke_test_id });
    audit(
      provisionedContract(smoke.agent_group_id)?.request_id ?? null,
      smoke.agent_group_id,
      'provision.smoke',
      'timeout',
      {},
    );
  }
  return expired.length;
}

export function getProvisionedSmokeTest(parent: Session, childId: string): Record<string, unknown> {
  if (!hasChildCapability(parent, childId, 'run-smoke-test') && !hasChildCapability(parent, childId, 'get-status'))
    return { ok: false, error: 'Child smoke result is not authorized.' };
  const smoke = getDb()
    .prepare(
      'SELECT fixture_id, state, output_redacted, started_at, finished_at FROM agent_smoke_test_results WHERE agent_group_id=? ORDER BY started_at DESC LIMIT 1',
    )
    .get(childId) as Record<string, unknown> | undefined;
  return { ok: true, smoke_test: smoke ?? null };
}

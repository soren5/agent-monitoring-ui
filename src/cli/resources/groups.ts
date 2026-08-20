import { randomUUID } from 'crypto';

import type { AdditionalMountConfig, McpServerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import { initGroupFilesystem } from '../../group-init.js';
import { enrollFactoryManagedAgent } from '../../modules/agent-to-agent/factory.js';
import { issueRootGrant } from '../../modules/agent-to-agent/capabilities.js';
import { createProject } from '../../modules/agent-to-agent/projects.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { isValidTimezone } from '../../timezone.js';
import type { AgentGroup, ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/**
 * Parse a --timezone flag: undefined = not passed, null = explicit clear
 * (empty string → follow the install default), otherwise a validated IANA id.
 * Invalid ids throw here, in the handler — for agent callers that is after
 * approval (rare, self-healing: a retry raises a fresh card).
 */
function parseTimezoneFlag(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const tz = String(value);
  if (tz === '') return null;
  if (!isValidTimezone(tz)) {
    throw new Error(
      `invalid --timezone: "${tz}" is not an IANA timezone id (e.g. "Europe/Lisbon"); pass "" to follow the install default`,
    );
  }
  return tz;
}

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    timezone: row.timezone,
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` and `delete` are custom (below): create needs a `--template`
  // branch, and the generic create inserts a bare agent_groups row but never
  // the container_config a working group needs; the generic single-table
  // DELETE violates FK constraints (#2525).
  operations: { list: 'open', get: 'open', update: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create (or return the existing) agent group with its container config. Idempotent on --folder. ' +
        'With --template <ref>, stamp from a local template under templates/ (MCP servers + instructions ' +
        '+ skills + paused recurring tasks). Use --folder <slug> and --name <display name>. ' +
        'Optional --timezone <IANA id> sets the group timezone (template task schedules fire in it); like --name, it is ignored when the folder already exists.',
      handler: async (args) => {
        const timezone = parseTimezoneFlag(args.timezone) ?? undefined;
        if (args.template) {
          return createAgentFromTemplate(String(args.template), {
            name: args.name ? String(args.name) : undefined,
            timezone,
          });
        }
        const folder = args.folder as string;
        if (!folder) throw new Error('--folder is required');
        const name = (args.name as string) ?? folder;
        const existing = getAgentGroupByFolder(folder);
        if (existing) {
          initGroupFilesystem(existing); // ensure a reused group is fully configured too (idempotent; also repairs a missing workspace folder)
          return existing;
        }
        const id = `ag-${randomUUID()}`;
        const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
        createAgentGroup(group);
        // Provision the workspace folder and the `container_configs` row that
        // `getContainerConfig` and the spawn path require. Without this, a
        // group created via `ncl groups create` would throw "Container config
        // not found" on first spawn and stay broken until the host restart
        // backfill ran (#2415). The template branch above provisions its own
        // config + folder in `createAgentFromTemplate`; this covers the bare
        // path. Mirrors what `setup/register.ts` does after creating an agent
        // group via the setup flow. The config row is stamped with the
        // instance default provider (`ensureContainerConfig` inside) — per-group
        // `groups config update --provider` still wins.
        initGroupFilesystem(group);
        if (timezone) updateContainerConfigScalars(id, { timezone });
        return getAgentGroupByFolder(folder);
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = hasTable(db, 'agent_destinations');
        const hasPendingApprovals = hasTable(db, 'pending_approvals');

        // FK-ordered cascade. Single sync transaction — better-sqlite3 rolls
        // back the whole thing if any statement throws (e.g. an FK constraint
        // we missed), so the central DB stays consistent. The `removed` counts
        // are sourced from each DELETE's `changes` so they describe exactly
        // what the transaction did, not a separate pre-flight snapshot.
        const cascade = db.transaction((groupId: string) => {
          const counts = {
            sessions: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
            container_configs: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = db
              .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
              .run(groupId).changes;
            counts.agent_destinations_pointing = db
              .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
              .run('agent', groupId).changes;
          }
          counts.pending_questions = db
            .prepare(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
            )
            .run(groupId).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = db
              .prepare(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              )
              .run(groupId, groupId).changes;
          }
          counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
          counts.pending_sender_approvals = db
            .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.pending_channel_approvals = db
            .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.messaging_group_agents = db
            .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.agent_group_members = db
            .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = db
            .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
            .run(groupId).changes;
          db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
          return counts;
        });
        const removed = cascade(id);

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'factory enroll': {
      access: 'approval',
      hostOnly: true,
      description:
        'Enroll an existing agent in the Copilot Agent Factory. OPERATOR-ONLY: this grants no new runtime access; it only makes an explicitly named agent visible to the narrow factory API. ' +
        'Use --id <group-id> --template <requirements|benchmarker|librarian|junior|researcher|reviewer|classifier|formatter>.',
      handler: async (args) => {
        const id = args.id as string;
        const template = args.template as string;
        if (!id || !template) throw new Error('--id and --template are required');
        enrollFactoryManagedAgent(id, template);
        return { enrolled: id, template };
      },
    },
    'project create': {
      access: 'approval',
      hostOnly: true,
      description:
        'OWNER-ONLY: create a new host-owned shared Discord project channel. It never takes over an existing channel wiring. ' +
        'Use --project-id <id> --parent-group-id <requirements-group-id> --platform-id discord:<server-id>:<channel-id>, then grant exact project capabilities to the parent.',
      handler: async (args) => {
        const projectId = args.project_id as string;
        const parentGroupId = args.parent_group_id as string;
        const platformId = args.platform_id as string;
        if (!projectId || !parentGroupId || !platformId)
          throw new Error('--project-id, --parent-group-id, and --platform-id are required');
        return createProject(projectId, parentGroupId, platformId);
      },
    },
    'capability grant-root': {
      access: 'approval',
      hostOnly: true,
      description:
        'OWNER-ONLY: issue one exact root capability. Use --id <group-id> --resource-type <type> --resource-id <id> --action <action>. Optional constraints: --branch-prefix, --head-prefix, --descendant-agent-group-id, --channel-type, --platform-id.',
      handler: async (args) => {
        const id = args.id as string;
        const resourceType = args.resource_type as string;
        const resourceId = args.resource_id as string;
        const action = args.action as string;
        if (!id || !resourceType || !resourceId || !action)
          throw new Error('--id, --resource-type, --resource-id, and --action are required');
        const branchPrefix = args.branch_prefix as string | undefined;
        const headPrefix = args.head_prefix as string | undefined;
        const descendantAgentGroupId = args.descendant_agent_group_id as string | undefined;
        const channelType = args.channel_type as string | undefined;
        const platformId = args.platform_id as string | undefined;
        const constraints: Record<string, string> = {};
        if (branchPrefix) constraints.branch_prefix = branchPrefix;
        if (headPrefix) constraints.head_prefix = headPrefix;
        if (descendantAgentGroupId) constraints.descendant_agent_group_id = descendantAgentGroupId;
        if (channelType) constraints.channel_type = channelType;
        if (platformId) constraints.platform_id = platformId;
        const grantId = issueRootGrant(id, { resourceType, resourceId, action, constraints }, 'operator:ncl');
        return {
          granted: true,
          grant_id: grantId,
          subject: id,
          resource_type: resourceType,
          resource_id: resourceId,
          action,
          constraints,
        };
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, ' +
        '--timezone (IANA id like "Europe/Lisbon"; "" clears back to the install default; scheduled-task times follow it immediately, message display after restart).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
            | 'timezone'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        const timezone = parseTimezoneFlag(args.timezone);
        if (timezone !== undefined) updates.timezone = timezone;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, --timezone',
          );
        }

        updateContainerConfigScalars(id, updates);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
    'config add-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        "Mount a host directory into a group's containers. OPERATOR-ONLY — never runnable from " +
        'inside a container (mounting host paths is a filesystem-access boundary). Requires ' +
        '`ncl groups restart` to take effect. Use --id <group-id> --host <host-path> --container <container-path> [--ro].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const mount: AdditionalMountConfig = {
          hostPath,
          containerPath,
          // Omit --ro means the operator explicitly requests a writable mount.
          // Persisting `false` matters because mount security otherwise treats
          // an omitted value as read-only.
          readonly: Boolean(args.ro || args.readonly),
        };
        const existing = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
        if (!existing.some((m) => m.hostPath === hostPath && m.containerPath === containerPath)) {
          existing.push(mount);
          updateContainerConfigJson(id, 'additional_mounts', existing);
        }
        return { added: mount, note: `Run \`ncl groups restart --id ${id}\` for the mount to take effect.` };
      },
    },
    'config remove-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove a host mount from a group. OPERATOR-ONLY. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --host <host-path> --container <container-path>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const existing = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
        const filtered = existing.filter((m) => !(m.hostPath === hostPath && m.containerPath === containerPath));
        updateContainerConfigJson(id, 'additional_mounts', filtered);
        return { removed: { hostPath, containerPath }, note: `Run \`ncl groups restart --id ${id}\` to apply.` };
      },
    },
    'provider switch': {
      access: 'approval',
      hostOnly: true,
      description:
        'Switch a group between providers (codex ↔ deepseek) with an agent-written handoff prompt. OPERATOR-ONLY. ' +
        "The host asks the current provider's agent to write a handoff prompt to its workspace and signal readiness; " +
        'on readiness the host switches the provider/model and restarts with the handoff as initialization context. ' +
        'Reversible — run again with the other provider to switch back. Use --id <group-id> --to <deepseek|codex>. ' +
        'Watch progress with `ncl groups provider status --id <group-id>`.',
      args: [
        { name: 'id', type: 'string', required: true, description: 'Agent group id.' },
        { name: 'to', type: 'string', required: true, enum: ['deepseek', 'codex'], description: 'Target provider.' },
      ],
      examples: ['ncl groups provider switch --id <group-id> --to deepseek'],
      handler: async (args) => {
        const id = args.id as string;
        const to = args.to as string;
        const { startProviderSwitch } = await import('../../modules/agent-to-agent/provider-migration.js');
        return startProviderSwitch(id, to);
      },
      formatHuman: (data: unknown) => {
        const r = data as { migration_id: string; from_provider: string; to_provider: string; state: string };
        return (
          `Migration ${r.migration_id} started (${r.from_provider} → ${r.to_provider}, ${r.state}). ` +
          `The agent has been asked to write a handoff prompt; it will switch when it signals readiness. ` +
          `Check status with \`ncl groups provider status\`.`
        );
      },
    },
    'provider status': {
      access: 'approval',
      hostOnly: true,
      description:
        'Show the current or latest provider migration state for a group. OPERATOR-ONLY. ' +
        'Use --id <group-id>. Redacted — never includes raw handoff content.',
      args: [{ name: 'id', type: 'string', required: true, description: 'Agent group id.' }],
      examples: ['ncl groups provider status --id <group-id>'],
      handler: async (args) => {
        const id = args.id as string;
        const { getProviderMigrationStatus } = await import('../../modules/agent-to-agent/provider-migration.js');
        return getProviderMigrationStatus(id);
      },
    },
    'provider abort': {
      access: 'approval',
      hostOnly: true,
      description:
        'Abort a pending provider migration without switching. The current provider stays. OPERATOR-ONLY. ' +
        'Use --id <group-id>.',
      args: [{ name: 'id', type: 'string', required: true, description: 'Agent group id.' }],
      examples: ['ncl groups provider abort --id <group-id>'],
      handler: async (args) => {
        const id = args.id as string;
        const { abortProviderMigration } = await import('../../modules/agent-to-agent/provider-migration.js');
        return abortProviderMigration(id);
      },
    },
  },
});

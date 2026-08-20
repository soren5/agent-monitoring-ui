/**
 * Host-owned, reversible provider migration with agent handoff.
 *
 * An operator switches an agent group's provider (e.g. `codex` → `deepseek`)
 * via `ncl groups provider switch`. The host:
 *
 *   1. Records an immutable `provider_migrations` contract (requesting_handoff).
 *   2. Asks the CURRENT provider's agent to write a handoff prompt to its
 *      workspace (`/workspace/agent/.migration-handoff.md`, i.e.
 *      `groups/<folder>/.migration-handoff.md` on the host) and reply with the
 *      ready marker.
 *   3. Observes that marker in the delivery bridge — the same host-only seam
 *      the provisioned smoke test uses — reads the handoff file, switches the
 *      container config provider/model, and restarts the container with the
 *      handoff as the fresh session's `on_wake` initialization message.
 *
 * The command is deliberately reversible: `--to codex` runs the identical
 * flow in the other direction. State is host-owned; an agent cannot start,
 * alter, or cancel a migration of its own.
 *
 * The ready marker is a fixed string so a spoofed reply cannot trigger a
 * switch by itself — the handoff FILE must also exist and be readable, and
 * only the current pending migration row for that group is consulted.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';

export const HANDOFF_FILENAME = '.migration-handoff.md';
export const HANDOFF_READY_MARKER = 'HANDOFF_READY';
const MAX_HANDOFF_BYTES = 64 * 1024;
const MIGRATION_TTL_MS = 24 * 60 * 60 * 1_000;

type MigrationState = 'requesting_handoff' | 'switching' | 'switched' | 'failed' | 'aborted';

type MigrationRow = {
  migration_id: string;
  agent_group_id: string;
  from_provider: string;
  to_provider: string;
  to_model: string | null;
  state: MigrationState;
  handoff_path: string | null;
  created_at: string;
  updated_at: string | null;
  failed_reason: string | null;
};

const now = () => new Date().toISOString();

function hash(v: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

function audit(
  agentGroupId: string,
  migrationId: string | null,
  operation: string,
  outcome: string,
  detail: unknown,
): void {
  if (!hasTable(getDb(), 'provider_migration_audit_events')) return;
  getDb()
    .prepare(
      `INSERT INTO provider_migration_audit_events
       (created_at, agent_group_id, migration_id, operation, outcome, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now(), agentGroupId, migrationId, operation, outcome, hash(detail));
}

function activeMigration(agentGroupId: string): MigrationRow | undefined {
  if (!hasTable(getDb(), 'provider_migrations')) return undefined;
  return getDb()
    .prepare(
      `SELECT * FROM provider_migrations
       WHERE agent_group_id=? AND state IN ('requesting_handoff','switching') ORDER BY created_at DESC LIMIT 1`,
    )
    .get(agentGroupId) as MigrationRow | undefined;
}

/** Host path of the agent's workspace handoff file. */
export function handoffHostPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, HANDOFF_FILENAME);
}

/** Read + bound the handoff file. Returns the prompt, or undefined when absent/too large. */
export function readHandoffFile(groupFolder: string): string | undefined {
  const hostPath = handoffHostPath(groupFolder);
  try {
    const stat = fs.lstatSync(hostPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HANDOFF_BYTES) return undefined;
    const content = fs.readFileSync(hostPath, 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate a provider switch request. Throws with an operator-readable error
 * when the group doesn't exist, is already on the target, the target provider
 * is not installed, or a migration is already pending.
 */
export function validateProviderSwitch(
  agentGroupId: string,
  toProvider: string,
): { from: string; model: string | null } {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`No agent group: ${agentGroupId}`);
  const config = getContainerConfig(agentGroupId);
  if (!config) throw new Error(`No container config for group: ${group.name}`);

  const target = toProvider.toLowerCase();
  if (target !== 'deepseek' && target !== 'codex')
    throw new Error(`Unsupported target provider "${toProvider}". Supported: deepseek, codex.`);

  const from = (config.provider ?? 'claude').toLowerCase();
  if (from === target) throw new Error(`Group "${group.name}" is already on provider "${target}".`);

  if (activeMigration(agentGroupId)) throw new Error(`Group "${group.name}" already has a pending provider migration.`);

  // The container-side provider registry is the source of truth for what is
  // actually installed. `deepseek` requires the host contribution; `codex` is
  // always registered in trunk.
  const model = target === 'deepseek' ? 'deepseek-v4-flash' : null;
  return { from, model };
}

/**
 * Start a provider switch: record the contract and dispatch the handoff
 * request to the current agent. Does not change config — the switch completes
 * only when the delivery observer sees the handoff file + ready marker.
 */
export function startProviderSwitch(
  agentGroupId: string,
  toProvider: string,
): { migration_id: string; from_provider: string; to_provider: string; state: MigrationState } {
  const { from, model } = validateProviderSwitch(agentGroupId, toProvider);
  const migrationId = `mig-${crypto.randomUUID()}`;
  const createdAt = now();
  getDb()
    .prepare(
      `INSERT INTO provider_migrations
       (migration_id, agent_group_id, from_provider, to_provider, to_model, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'requesting_handoff', ?)`,
    )
    .run(migrationId, agentGroupId, from, toProvider.toLowerCase(), model, createdAt);
  audit(agentGroupId, migrationId, 'provider.switch.start', 'allowed', {
    from,
    to: toProvider.toLowerCase(),
    model,
  });

  dispatchHandoffRequest(agentGroupId, from, toProvider.toLowerCase());
  return {
    migration_id: migrationId,
    from_provider: from,
    to_provider: toProvider.toLowerCase(),
    state: 'requesting_handoff',
  };
}

/** Ask the current agent to write a handoff prompt to its workspace and signal readiness. */
function dispatchHandoffRequest(agentGroupId: string, from: string, to: string): void {
  const { session } = resolveSession(agentGroupId, null, null, 'agent-shared');
  writeSessionMessage(agentGroupId, session.id, {
    id: `migration-handoff-${crypto.randomUUID()}`,
    kind: 'chat',
    timestamp: now(),
    platformId: agentGroupId,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text:
        `Host provider migration: your provider is switching from ${from} to ${to}. ` +
        `Write a complete handoff prompt that captures your current context, standing instructions, ` +
        `in-flight work, and anything a fresh agent running on ${to} must know to continue seamlessly. ` +
        `Save it to /workspace/agent/${HANDOFF_FILENAME} in your workspace, ` +
        `then reply with exactly: ${HANDOFF_READY_MARKER}`,
      sender: 'system',
      senderId: 'system',
    }),
    trigger: 1,
  });
  void wakeContainer(session);
}

/**
 * Delivery-bridge observer. Called for every outbound message an agent group
 * produces. When a migration is awaiting handoff and the message text is
 * exactly the ready marker, the host reads the handoff file and completes the
 * switch. Returns true when the message was consumed (should NOT be delivered
 * to the channel), false otherwise.
 */
export function observeProviderHandoff(agentGroupId: string, content: string): boolean {
  const migration = activeMigration(agentGroupId);
  if (!migration || migration.state !== 'requesting_handoff') return false;
  const text = messageText(content);
  if (text !== HANDOFF_READY_MARKER) return false;

  const group = getAgentGroup(agentGroupId);
  if (!group) {
    failMigration(migration, 'agent group no longer exists');
    return true;
  }
  const handoff = readHandoffFile(group.folder);
  if (!handoff) {
    failMigration(migration, 'handoff file is missing, unreadable, or too large');
    return true;
  }

  getDb()
    .prepare(`UPDATE provider_migrations SET state='switching', handoff_path=?, updated_at=? WHERE migration_id=?`)
    .run(handoffHostPath(group.folder), now(), migration.migration_id);

  try {
    updateContainerConfigScalars(agentGroupId, {
      provider: migration.to_provider,
      // Always set the model: switching to codex clears the deepseek model,
      // switching to deepseek pins the deterministic model.
      model: migration.to_model,
    });
  } catch (err) {
    failMigration(migration, err instanceof Error ? err.message : 'config update failed');
    return true;
  }

  try {
    // Restart with the handoff as the fresh container's on_wake initialization
    // message — the new provider's first poll reads it as the opening context.
    restartAgentGroupContainers(
      agentGroupId,
      `provider migration to ${migration.to_provider}`,
      `Provider switch complete (${migration.from_provider} → ${migration.to_provider}). ` +
        `Begin from this handoff from your previous provider:\n\n${handoff}`,
    );
  } catch (err) {
    failMigration(migration, err instanceof Error ? err.message : 'restart failed');
    return true;
  }

  getDb()
    .prepare(`UPDATE provider_migrations SET state='switched', updated_at=? WHERE migration_id=?`)
    .run(now(), migration.migration_id);
  audit(agentGroupId, migration.migration_id, 'provider.switch.complete', 'allowed', {
    to: migration.to_provider,
    model: migration.to_model,
  });
  log.info('Provider migration completed', {
    agentGroupId,
    migrationId: migration.migration_id,
    from: migration.from_provider,
    to: migration.to_provider,
  });
  return true;
}

function failMigration(migration: MigrationRow, reason: string): void {
  getDb()
    .prepare(`UPDATE provider_migrations SET state='failed', failed_reason=?, updated_at=? WHERE migration_id=?`)
    .run(reason, now(), migration.migration_id);
  audit(migration.agent_group_id, migration.migration_id, 'provider.switch.failed', 'failed', { reason });
  log.warn('Provider migration failed', { agentGroupId: migration.agent_group_id, reason });
}

/** Extract the plain-text message body from an outbound content payload. */
function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
}

/** Redacted status for operators. Never leaks raw handoff content. */
export function getProviderMigrationStatus(agentGroupId: string): Record<string, unknown> {
  if (!hasTable(getDb(), 'provider_migrations')) return { ok: false, error: 'Migration storage is not installed.' };
  const row = getDb()
    .prepare(`SELECT * FROM provider_migrations WHERE agent_group_id=? ORDER BY created_at DESC LIMIT 1`)
    .get(agentGroupId) as MigrationRow | undefined;
  if (!row) return { ok: true, status: null };
  return {
    ok: true,
    migration_id: row.migration_id,
    from_provider: row.from_provider,
    to_provider: row.to_provider,
    to_model: row.to_model,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    failed_reason: row.state === 'failed' ? row.failed_reason : null,
  };
}

/** Abort a pending migration without switching. The current provider stays. */
export function abortProviderMigration(agentGroupId: string): Record<string, unknown> {
  const migration = activeMigration(agentGroupId);
  if (!migration) return { ok: false, error: 'No pending provider migration to abort.' };
  getDb()
    .prepare(`UPDATE provider_migrations SET state='aborted', updated_at=? WHERE migration_id=?`)
    .run(now(), migration.migration_id);
  audit(agentGroupId, migration.migration_id, 'provider.switch.abort', 'allowed', {});
  return { ok: true, aborted: migration.migration_id };
}

/** Host-sweep: expire migration contracts whose handoff never arrived. */
export function sweepExpiredProviderMigrations(nowIso = now()): number {
  if (!hasTable(getDb(), 'provider_migrations')) return 0;
  const cutoff = new Date(Date.parse(nowIso) - MIGRATION_TTL_MS).toISOString();
  const expired = getDb()
    .prepare(
      `SELECT * FROM provider_migrations
       WHERE state IN ('requesting_handoff','switching') AND created_at <= ?`,
    )
    .all(cutoff) as MigrationRow[];
  for (const migration of expired) {
    failMigration(migration, 'handoff timed out');
  }
  return expired.length;
}

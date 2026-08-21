/**
 * Host-owned isolated repository worktrees for provisioned children.
 *
 * A provisioned child with a `repository_id` gets repository grants (the broker
 * operates on GitHub remotely via the app installation), but no local writable
 * checkout to implement against. This module gives each such child an isolated
 * git worktree of its repository at a pinned base SHA, mounted read-write into
 * the container at `/workspace/extra/repo`.
 *
 * The worktree lives under `WORKTREES_DIR/<child-id>/` on the host. It is the
 * child's exclusive working copy: only that child's container mounts it. The
 * child edits files there and uses the repository MCP tools (broker) to push —
 * the broker injects the GitHub App credential, never a raw token.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { WORKTREES_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { log } from '../../log.js';

const MOUNT_ALLOWLIST_PATH = path.join(process.env.HOME ?? '', '.config', 'nanoclaw', 'mount-allowlist.json');

/**
 * The git repository that backs per-child worktrees for `repository_id`.
 * The consolidated project repo lives at this path; worktrees are created from
 * it so they share object storage and pick up the exact merged base.
 */
function repositorySource(repositoryId: string): string {
  // Only the consolidated single-repo is supported as a worktree source today.
  if (repositoryId !== 'soren5/agent-monitoring-ui') {
    throw new Error(`No worktree source configured for repository ${repositoryId}`);
  }
  return '/Users/soren/Work/agent-monitoring-ui';
}

/**
 * Create an isolated writable checkout for a provisioned child at the given
 * base SHA, and return the host path. Idempotent: returns the existing path if
 * the checkout already exists for this child.
 *
 * The checkout is a SELF-CONTAINED clone (its own `.git`), not a linked
 * worktree: a worktree's `.git` points at the source repo's object store, which
 * is not mounted into the agent container, so `git` inside the container would
 * fail. A standalone clone keeps the child fully independent and writable.
 */
export function ensureChildWorktree(childGroupId: string, repositoryId: string, baseSha: string): string {
  const group = getAgentGroup(childGroupId);
  if (!group) throw new Error('Child agent group not found.');

  const source = repositorySource(repositoryId);
  if (!fs.existsSync(path.join(source, '.git'))) throw new Error(`Worktree source is not a git repository: ${source}`);
  try {
    execFileSync('git', ['-C', source, 'cat-file', '-e', `${baseSha}^{commit}`], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Base SHA ${baseSha} is not present in ${source}. Fetch/pull the source first.`, {
      cause: err,
    });
  }

  const checkoutPath = path.join(WORKTREES_DIR, childGroupId);
  if (fs.existsSync(path.join(checkoutPath, '.git'))) {
    log.info('Reusing existing child checkout', { childGroupId, checkoutPath });
    return checkoutPath;
  }
  // Stale leftover from an aborted attempt (e.g. the earlier worktree linking)
  if (fs.existsSync(checkoutPath)) {
    fs.rmSync(checkoutPath, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
  // Bare-format clone from the local source, then a detached checkout pinned to
  // the exact base SHA. The child's first action creates its granted feature
  // branch from here via the broker.
  execFileSync('git', ['clone', '--no-checkout', source, checkoutPath], { stdio: 'pipe' });
  execFileSync('git', ['-C', checkoutPath, 'checkout', '--detach', baseSha], { stdio: 'pipe' });
  log.info('Created isolated child checkout', { childGroupId, repositoryId, baseSha, checkoutPath });
  return checkoutPath;
}

/**
 * Allowlist the worktrees root for read-write mounts so `validateMount` accepts
 * the per-child worktree. Idempotent; writes the external allowlist file.
 */
export function ensureWorktreesAllowlisted(): void {
  let allowlist: { allowedRoots: Array<Record<string, unknown>>; blockedPatterns?: string[] };
  try {
    allowlist = JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `Mount allowlist is unreadable at ${MOUNT_ALLOWLIST_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const root = path.resolve(WORKTREES_DIR);
  if (allowlist.allowedRoots.some((r) => path.resolve(String(r.path)) === root)) return;
  const entry = {
    path: root,
    allowReadWrite: true,
    description: 'Isolated per-agent repository worktrees (read-write)',
  };
  // Insert before any broader read-only ancestor (e.g. the Agent Orchestration
  // workspace root) so the more-specific writable root wins in findAllowedRoot,
  // which returns the first containing root in order.
  const parentIdx = allowlist.allowedRoots.findIndex((r) => {
    const p = path.resolve(String(r.path));
    return p !== root && root.startsWith(p + path.sep);
  });
  if (parentIdx >= 0) allowlist.allowedRoots.splice(parentIdx, 0, entry);
  else allowlist.allowedRoots.push(entry);
  fs.writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
  log.info('Mount allowlist: added worktrees root', { root });
}

/**
 * Mount a child's worktree into its container config as a read-write
 * additional mount at `/workspace/extra/repo`. Idempotent.
 */
export function mountChildWorktree(childGroupId: string, worktreePath: string): void {
  const config = getContainerConfigJson(childGroupId);
  const mounts = Array.isArray(config.additionalMounts) ? config.additionalMounts : [];
  const already = mounts.some((m: { hostPath?: string }) => path.resolve(String(m.hostPath)) === worktreePath);
  if (already) return;
  mounts.push({
    hostPath: worktreePath,
    // Relative container path — the mount validator prefixes /workspace/extra/,
    // so the agent sees the checkout at /workspace/extra/repo.
    containerPath: 'repo',
    readonly: false,
  });
  updateContainerConfigJson(childGroupId, 'additional_mounts', mounts);
  log.info('Mounted child worktree into container config', { childGroupId, worktreePath });
}

interface ContainerConfigShape {
  additionalMounts?: Array<{ hostPath?: string; containerPath?: string; readonly?: boolean }>;
}

function getContainerConfigJson(childGroupId: string): ContainerConfigShape {
  // The DB is the source of truth for the merge below.
  const row = getContainerConfig(childGroupId);
  if (!row) throw new Error('Child container config not found.');
  return {
    additionalMounts: JSON.parse(row.additional_mounts) as Array<{
      hostPath?: string;
      containerPath?: string;
      readonly?: boolean;
    }>,
  };
}

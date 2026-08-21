/** Host-only GitHub App authentication. Tokens never enter agent containers. */
import crypto from 'crypto';
import fs from 'fs';
import { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH } from './config.js';
import { findEffectiveGrant } from './modules/agent-to-agent/capabilities.js';

let cached: { token: string; expiresAt: number } | undefined;
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function appJwt(): string {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_PATH) throw new Error('GitHub App broker is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ iat: now - 30, exp: now + 540, iss: GITHUB_APP_ID }));
  const input = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), fs.readFileSync(GITHUB_APP_PRIVATE_KEY_PATH));
  return `${input}.${b64(signature)}`;
}

export async function getGitHubInstallationToken(): Promise<string> {
  if (!GITHUB_APP_INSTALLATION_ID) throw new Error('GitHub App installation is not configured.');
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch(`https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nanoclaw-repository-broker',
    },
  });
  if (!response.ok) throw new Error(`GitHub App token request failed (${response.status}).`);
  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) throw new Error('GitHub App token response was incomplete.');
  cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
  return cached.token;
}

function parseRepository(repository: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error('Repository must be an owner/name identifier.');
  return [match[1], match[2]];
}

/** Read-only repository metadata. Authorization happens before any token or request is used. */
export async function getRepositoryMetadata(
  subjectAgentGroupId: string,
  repository: string,
): Promise<Record<string, unknown>> {
  if (
    !findEffectiveGrant(subjectAgentGroupId, { resourceType: 'repository', resourceId: repository, action: 'read' })
  ) {
    throw new Error(`Capability denied: ${subjectAgentGroupId} lacks repository read for ${repository}.`);
  }
  const [owner, name] = parseRepository(repository);
  const token = await getGitHubInstallationToken();
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nanoclaw-repository-broker',
    },
  });
  if (!response.ok) throw new Error(`GitHub repository read failed (${response.status}).`);
  const body = (await response.json()) as {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
    archived?: boolean;
  };
  return {
    full_name: body.full_name,
    default_branch: body.default_branch,
    private: body.private,
    archived: body.archived,
  };
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getGitHubInstallationToken();
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nanoclaw-repository-broker',
      ...(init.headers ?? {}),
    },
  });
}

/** Creates one branch from an explicit base ref, constrained to the grant's prefix. */
export async function createFeatureBranch(
  subjectAgentGroupId: string,
  repository: string,
  branch: string,
  base = 'main',
): Promise<{ branch: string; sha: string }> {
  const grant = findEffectiveGrant(subjectAgentGroupId, {
    resourceType: 'repository',
    resourceId: repository,
    action: 'branch-write',
  });
  const prefix = grant && (JSON.parse(grant.constraints_json) as { branch_prefix?: unknown }).branch_prefix;
  if (!grant || typeof prefix !== 'string' || !branch.startsWith(prefix))
    throw new Error(`Capability denied: branch is outside the granted prefix.`);
  const [owner, name] = parseRepository(repository);
  const baseRef = await github(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(base)}`);
  if (!baseRef.ok) throw new Error(`GitHub base ref read failed (${baseRef.status}).`);
  const baseBody = (await baseRef.json()) as { object?: { sha?: string } };
  const sha = baseBody.object?.sha;
  if (!sha) throw new Error('GitHub base ref response was incomplete.');
  const created = await github(`/repos/${owner}/${name}/git/refs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!created.ok) throw new Error(`GitHub branch creation failed (${created.status}).`);
  return { branch, sha };
}

/** Opens a PR from a granted branch prefix. The caller cannot choose an arbitrary head. */
export async function createPullRequest(
  subjectAgentGroupId: string,
  repository: string,
  head: string,
  title: string,
  body: string,
  base = 'main',
): Promise<{ number: number; url: string }> {
  const grant = findEffectiveGrant(subjectAgentGroupId, {
    resourceType: 'repository',
    resourceId: repository,
    action: 'pr-create',
  });
  const prefix = grant && (JSON.parse(grant.constraints_json) as { head_prefix?: unknown }).head_prefix;
  if (!grant || typeof prefix !== 'string' || !head.startsWith(prefix))
    throw new Error('Capability denied: pull-request head is outside the granted prefix.');
  if (!title.trim() || title.length > 240 || body.length > 20_000)
    throw new Error('Pull-request title or body is invalid.');
  const [owner, name] = parseRepository(repository);
  const response = await github(`/repos/${owner}/${name}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!response.ok) throw new Error(`GitHub pull-request creation failed (${response.status}).`);
  const created = (await response.json()) as { number?: number; html_url?: string };
  if (!created.number || !created.html_url) throw new Error('GitHub pull-request response was incomplete.');
  return { number: created.number, url: created.html_url };
}

/**
 * Merges one reviewed pull request. The caller needs an explicit pr-merge
 * grant, and the PR head must remain inside that grant's delegated branch
 * namespace. GitHub's branch protection/ruleset checks remain authoritative.
 */
export async function mergePullRequest(
  subjectAgentGroupId: string,
  repository: string,
  pullNumber: number,
): Promise<{ merged: boolean; sha: string | null }> {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new Error('Pull-request number is invalid.');
  const grant = findEffectiveGrant(subjectAgentGroupId, {
    resourceType: 'repository',
    resourceId: repository,
    action: 'pr-merge',
  });
  const prefix = grant && (JSON.parse(grant.constraints_json) as { branch_prefix?: unknown }).branch_prefix;
  if (!grant || typeof prefix !== 'string') throw new Error('Capability denied: pull-request merge is not granted.');
  const [owner, name] = parseRepository(repository);
  const pull = await github(`/repos/${owner}/${name}/pulls/${pullNumber}`);
  if (!pull.ok) throw new Error(`GitHub pull-request read failed (${pull.status}).`);
  const details = (await pull.json()) as { state?: string; merged?: boolean; head?: { ref?: string } };
  if (details.state !== 'open' || details.merged || !details.head?.ref?.startsWith(prefix))
    throw new Error('Pull request is not an open delegated descendant branch.');
  const merged = await github(`/repos/${owner}/${name}/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  if (!merged.ok) throw new Error(`GitHub pull-request merge failed (${merged.status}).`);
  const result = (await merged.json()) as { merged?: boolean; sha?: string };
  if (!result.merged) throw new Error('GitHub did not merge the pull request.');
  return { merged: true, sha: result.sha ?? null };
}

/** Writes one bounded source file to a granted feature branch; no git credential reaches the caller. */
export async function writeRepositoryFile(
  subjectAgentGroupId: string,
  repository: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  if (
    !filePath ||
    filePath.startsWith('/') ||
    filePath.split('/').includes('..') ||
    content.length > 250_000 ||
    !message.trim()
  )
    throw new Error('Repository write request is invalid.');
  const grant = findEffectiveGrant(subjectAgentGroupId, {
    resourceType: 'repository',
    resourceId: repository,
    action: 'branch-write',
  });
  const prefix = grant && (JSON.parse(grant.constraints_json) as { branch_prefix?: unknown }).branch_prefix;
  if (!grant || typeof prefix !== 'string' || !branch.startsWith(prefix))
    throw new Error('Capability denied: branch is outside the granted prefix.');
  const [owner, name] = parseRepository(repository);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const existing = await github(`/repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  const old = existing.status === 200 ? ((await existing.json()) as { sha?: string }) : undefined;
  if (!existing.ok && existing.status !== 404) throw new Error(`GitHub file lookup failed (${existing.status}).`);
  const response = await github(`/repos/${owner}/${name}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(old?.sha ? { sha: old.sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`GitHub file write failed (${response.status}).`);
}

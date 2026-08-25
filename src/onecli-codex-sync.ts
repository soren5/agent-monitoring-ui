/**
 * OneCLI codex credential sync.
 *
 * The container's codex auth is injected by the OneCLI gateway from its vault
 * secret (host pattern `chatgpt.com`), NOT from the host's `~/.codex/auth.json`.
 * When the user refreshes codex on the host (e.g. `codex login`), that file gets
 * new tokens but the vault keeps serving the stale ones until something pushes
 * them over — which is why codex intermittently 401s with `token_expired` after
 * an expiry and the fix is "sync `~/.codex/auth.json` into the vault".
 *
 * This module automates that: it watches `~/.codex/auth.json`, and whenever its
 * `last_refresh` timestamp is newer than the last one we pushed, it PATCHes the
 * vault's Codex secret with the full file contents (same JSON shape the secret
 * already stores). Gateway/MITM reloads the secret on the next injection, so no
 * container restart is required.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';

/** Host-side codex auth file — the source of truth for refreshed tokens. */
export const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
/** Where we persist the last `last_refresh` value we pushed, to detect changes. */
const SYNC_STATE_PATH = path.join(DATA_DIR, 'onecli-codex-sync-state.json');
/** Vault secret lookup — the gateway serves every secret from the web API. */
const SECRETS_ENDPOINT = `${ONECLI_URL}/api/secrets`;

const POLL_MS = 30_000;

interface SyncState {
  lastPushedRefresh?: string;
}

function readState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

function writeState(state: SyncState): void {
  fs.mkdirSync(path.dirname(SYNC_STATE_PATH), { recursive: true });
  fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * The codex CLI writes these sentinel values into `~/.codex/auth.json` while a
 * `codex login` flow is in flight — or after one was interrupted before the
 * browser/device step completed. Pushing such a file into the vault would
 * overwrite a valid token with placeholders and 401 every container, so the
 * sync refuses them.
 */
const CODEX_PLACEHOLDER_TOKENS = new Set(['at', 'rt', 'it', 'acct']);

function isPlaceholderAuth(parsed: { tokens?: Record<string, unknown> }): boolean {
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== 'object') return true;
  return ['access_token', 'id_token', 'refresh_token', 'account_id'].some(
    (key) => typeof tokens[key] === 'string' && CODEX_PLACEHOLDER_TOKENS.has(tokens[key] as string),
  );
}

/**
 * Push `~/.codex/auth.json` into the vault when its `last_refresh` is newer than
 * what we last pushed. Returns `true` when a push happened. Best-effort: never
 * throws — caller (watcher or poll) logs and continues.
 */
export async function syncCodexAuthIfNewer(): Promise<boolean> {
  let raw: string;
  try {
    raw = fs.readFileSync(CODEX_AUTH_PATH, 'utf8');
  } catch {
    // No host codex login yet — nothing to sync.
    return false;
  }

  let parsed: { last_refresh?: string; tokens?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { last_refresh?: string; tokens?: Record<string, unknown> };
  } catch {
    log.warn('Ignoring unparsable codex auth file', { path: CODEX_AUTH_PATH });
    return false;
  }

  if (isPlaceholderAuth(parsed)) {
    // A `codex login` that never completed leaves sentinel tokens. Never push
    // these over a valid vault credential — doing so 401s every container.
    log.warn('Ignoring codex auth placeholder skeleton (login not completed)', { path: CODEX_AUTH_PATH });
    return false;
  }

  const currentRefresh = parsed.last_refresh;
  if (!currentRefresh) {
    log.warn('Ignoring codex auth file without last_refresh', { path: CODEX_AUTH_PATH });
    return false;
  }

  const state = readState();
  if (state.lastPushedRefresh === currentRefresh) {
    return false;
  }

  // Find the vault Codex secret. The web API is project-scoped and unauthenticated
  // on localhost; the SDK's Bearer header is harmless to send when set.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ONECLI_API_KEY) headers.Authorization = `Bearer ${ONECLI_API_KEY}`;

  let secrets: Array<{ id: string; name: string }>;
  try {
    const res = await fetch(SECRETS_ENDPOINT, { headers });
    if (!res.ok) {
      log.warn('OneCLI secrets list failed', { status: res.status });
      return false;
    }
    secrets = (await res.json()) as Array<{ id: string; name: string }>;
  } catch (err) {
    log.warn('OneCLI secrets list request failed', { err });
    return false;
  }

  const codexSecret = secrets.find((s) => s.name === 'Codex');
  if (!codexSecret) {
    log.warn('No Codex secret in OneCLI vault — nothing to sync to');
    return false;
  }

  try {
    const res = await fetch(`${SECRETS_ENDPOINT}/${codexSecret.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: raw }),
    });
    if (!res.ok) {
      log.warn('Codex vault secret update failed', { status: res.status });
      return false;
    }
  } catch (err) {
    log.warn('Codex vault secret update request failed', { err });
    return false;
  }

  writeState({ lastPushedRefresh: currentRefresh });
  log.info('Synced refreshed codex auth into OneCLI vault', {
    lastRefresh: currentRefresh,
    secretId: codexSecret.id,
  });
  return true;
}

let watcher: fs.FSWatcher | null = null;
let polling = false;

/** Watch `~/.codex/auth.json` and push refreshes into the vault on change. */
export function startCodexAuthSync(): void {
  // Immediate first check so a token refreshed while the host was down syncs on
  // startup, then a polling fallback (fs.watch is not reliable for atomic
  // renames, which codex uses to write the file).
  void syncCodexAuthIfNewer().catch((err) => log.warn('Codex auth sync (startup) failed', { err }));

  try {
    watcher = fs.watch(CODEX_AUTH_PATH, () => {
      void syncCodexAuthIfNewer().catch((err) => log.warn('Codex auth sync failed', { err }));
    });
  } catch {
    // Watch can fail (e.g. file absent on a fresh host) — the poll still covers it.
  }

  if (polling) return;
  polling = true;
  poll();
}

function poll(): void {
  if (!polling) return;
  void syncCodexAuthIfNewer().catch((err) => log.warn('Codex auth sync failed', { err }));
  setTimeout(poll, POLL_MS);
}

export function stopCodexAuthSync(): void {
  polling = false;
  watcher?.close();
  watcher = null;
}

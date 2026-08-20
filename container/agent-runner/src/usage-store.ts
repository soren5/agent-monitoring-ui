/**
 * Persistent shared usage store — cross-provider "remaining usage" memory.
 *
 * Lives at `/workspace/agent/.nanoclaw/usage-store.json` in the group's
 * persistent shared workspace (the same dir that already holds codex's per-job
 * snapshots under `.nanoclaw/codex-usage/`), so it survives container respawns
 * and is visible to every session of the group.
 *
 * Each provider refreshes ONLY its own row when it runs; every report reads
 * BOTH rows. This is how a deepseek agent shows codex remaining usage without
 * ever calling the codex bridge — and vice versa. A stale or missing row
 * renders as `unavailable` and never blocks the other provider's report.
 */
import fs from 'fs';
import path from 'path';

export const USAGE_STORE_FILENAME = 'usage-store.json';

/**
 * Conservative per-token price used to estimate "tokens remaining" from the
 * DeepSeek currency balance. Uses the MOST expensive rate (output tokens,
 * deepseek-v4-flash: $0.28 / 1M per api-docs.deepseek.com/quick_start/pricing)
 * so the estimate never overstates what the balance can buy. Input is cheaper
 * ($0.14/M cache-miss, $0.0028/M cache-hit); reasoning agents skew output-heavy,
 * so output pricing is the honest worst case. Revisit if pricing changes (a
 * peak/off-peak 2x policy is announced but not yet in effect).
 */
const DEEPSEEK_PRICE_PER_TOKEN_USD = 0.28 / 1_000_000;


export interface CodexUsageStoreRow {
  weekly_limit_used_percent: number;
  weekly_limit_remaining_percent: number;
  captured_at: string;
}

export interface DeepseekBalance {
  currency: string;
  total_balance: string;
}

export interface DeepseekUsageStoreRow {
  cumulative_total_tokens: number;
  balance: DeepseekBalance | null;
  captured_at: string;
}

export interface UsageStore {
  schema_version: 'usage-store.v1';
  updated_at: string;
  codex?: CodexUsageStoreRow;
  deepseek?: DeepseekUsageStoreRow;
}

/** Default store used when the file is absent or unreadable — nothing blocks. */
export const EMPTY_USAGE_STORE: UsageStore = { schema_version: 'usage-store.v1', updated_at: '' };

const STALE_ROW_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

/** Host path of the shared store for a group workspace. */
export function usageStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.nanoclaw', USAGE_STORE_FILENAME);
}

export function readUsageStore(workspaceDir: string): UsageStore {
  const file = usageStorePath(workspaceDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UsageStore>;
    if (parsed.schema_version !== 'usage-store.v1') return { ...EMPTY_USAGE_STORE };
    return { ...EMPTY_USAGE_STORE, ...parsed } as UsageStore;
  } catch {
    return { ...EMPTY_USAGE_STORE };
  }
}

export function writeUsageStore(workspaceDir: string, store: UsageStore): void {
  const file = usageStorePath(workspaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...store, updated_at: now() }, null, 2)}\n`);
}

/** Set/replace the codex row, leaving the deepseek row untouched. */
export function updateCodexRow(workspaceDir: string, row: CodexUsageStoreRow): UsageStore {
  const store = readUsageStore(workspaceDir);
  store.codex = row;
  writeUsageStore(workspaceDir, store);
  return store;
}

/** Set/replace the deepseek row, leaving the codex row untouched. */
export function updateDeepseekRow(workspaceDir: string, row: DeepseekUsageStoreRow): UsageStore {
  const store = readUsageStore(workspaceDir);
  store.deepseek = row;
  writeUsageStore(workspaceDir, store);
  return store;
}

function isStale(capturedAt: string | undefined): boolean {
  if (!capturedAt) return true;
  return Date.parse(capturedAt) < Date.now() - STALE_ROW_MS;
}

export function formatRemainingUsage(workspaceDir: string): string[] {
  const store = readUsageStore(workspaceDir);
  const lines: string[] = [];

  const codex = store.codex;
  if (codex && !isStale(codex.captured_at) && Number.isFinite(codex.weekly_limit_remaining_percent)) {
    lines.push(`- Codex weekly limit remaining: ${formatPercent(codex.weekly_limit_remaining_percent)}`);
  } else {
    lines.push('- Codex weekly limit remaining: unavailable');
  }

  const deepseek = store.deepseek;
  if (deepseek && !isStale(deepseek.captured_at) && deepseek.balance) {
    const balance = Number(deepseek.balance.total_balance);
    const estimate =
      Number.isFinite(balance) && balance >= 0
        ? ` (~${Math.floor(balance / DEEPSEEK_PRICE_PER_TOKEN_USD).toLocaleString()} tokens remaining)`
        : '';
    lines.push(`- DeepSeek balance remaining: ${deepseek.balance.currency} ${deepseek.balance.total_balance}${estimate}`);
  } else {
    lines.push('- DeepSeek balance remaining: unavailable');
  }

  return lines;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

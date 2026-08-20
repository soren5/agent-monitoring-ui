import fs from 'fs';
import path from 'path';

import { touchHeartbeat } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import type { ProviderUsage } from './providers/types.js';
import { formatRemainingUsage, updateDeepseekRow } from './usage-store.js';

const BALANCE_TIMEOUT_MS = 10_000;
const SNAPSHOT_DIR = '.nanoclaw/deepseek-usage';

export interface DeepseekUsageJob {
  id: string;
  cwd: string;
  routing: RoutingContext;
  usage: ProviderUsage;
}

type BalanceFetcher = () => Promise<{ currency: string; total_balance: string } | null>;

let balanceFetcher: BalanceFetcher = fetchBalance;

/** Test seam only. Production uses the fixed /user/balance endpoint. */
export function setDeepseekBalanceFetcherForTest(fetcher: BalanceFetcher | null): void {
  balanceFetcher = fetcher ?? fetchBalance;
}

export function startDeepseekUsageJob(args: {
  providerName: string;
  cwd: string;
  routing: RoutingContext;
}): DeepseekUsageJob | null {
  if (args.providerName.toLowerCase() !== 'deepseek') return null;
  if (args.routing.channelType !== 'discord' || !args.routing.platformId) return null;
  return {
    id: `deepseek-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cwd: args.cwd,
    routing: args.routing,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

export async function finishDeepseekUsageJob(job: DeepseekUsageJob | null): Promise<void> {
  if (!job) return;
  if (job.usage.totalTokens === 0) return;

  const cumulative = writeAuditSnapshot(job.cwd, job.id, job.usage);
  updateDeepseekRow(job.cwd, {
    cumulative_total_tokens: cumulative,
    balance: await balanceFetcher(),
    captured_at: new Date().toISOString(),
  });
  reportUsage(job);
}

/**
 * DeepSeek balance from the fixed `/user/balance` endpoint. Reached in-band
 * through the OneCLI gateway proxy (same fixed host as chat completions; the
 * real credential is injected in flight). Returns null when unavailable.
 */
async function fetchBalance(): Promise<{ currency: string; total_balance: string } | null> {
  const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  // The balance endpoint lives at the API root, not under /v1.
  const root = base.replace(/\/v1\/?$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    touchHeartbeat();
    const response = await fetch(`${root}/user/balance`, { signal: controller.signal });
    touchHeartbeat();
    if (!response.ok) return null;
    const body = (await response.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const first = body.balance_infos?.[0];
    if (!first || typeof first.currency !== 'string' || typeof first.total_balance !== 'string') return null;
    return { currency: first.currency, total_balance: first.total_balance };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function readCumulativeTokens(cwd: string): number {
  const file = path.join(cwd, SNAPSHOT_DIR, 'cumulative.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { cumulative_total_tokens?: unknown };
    return typeof parsed.cumulative_total_tokens === 'number' && Number.isFinite(parsed.cumulative_total_tokens)
      ? parsed.cumulative_total_tokens
      : 0;
  } catch {
    return 0;
  }
}

/** Returns the updated cumulative token total for the group. */
function writeAuditSnapshot(cwd: string, jobId: string, usage: ProviderUsage): number {
  const dir = path.join(cwd, SNAPSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${safePathSegment(jobId)}.json`),
    `${JSON.stringify(
      {
        schema_version: 'deepseek-usage-snapshot.v1',
        job_id: jobId,
        captured_at: new Date().toISOString(),
        usage,
      },
      null,
      2,
    )}\n`,
  );
  // Cumulative running total for the group — single source of truth here, so
  // the shared store simply reads this back (no double counting).
  const cumulative = readCumulativeTokens(cwd) + usage.totalTokens;
  fs.writeFileSync(
    path.join(dir, 'cumulative.json'),
    `${JSON.stringify({ schema_version: 'deepseek-cumulative.v1', cumulative_total_tokens: cumulative }, null, 2)}\n`,
  );
  return cumulative;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function reportUsage(job: DeepseekUsageJob): void {
  const { routing } = job;
  writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: formatDeepseekUsage(job) }),
  });
}

export function formatDeepseekUsage(job: DeepseekUsageJob): string {
  const lines = [`DeepSeek usage for ${job.id}:`, `- total tokens: ${job.usage.totalTokens.toLocaleString()}`];
  lines.push(...formatRemainingUsage(job.cwd));
  return lines.join('\n');
}

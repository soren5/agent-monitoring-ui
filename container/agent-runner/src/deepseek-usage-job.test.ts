import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  finishDeepseekUsageJob,
  formatDeepseekUsage,
  setDeepseekBalanceFetcherForTest,
  startDeepseekUsageJob,
  type DeepseekUsageJob,
} from './deepseek-usage-job.js';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { readUsageStore } from './usage-store.js';

let tmp = '';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  setDeepseekBalanceFetcherForTest(null);
  delete process.env.DEEPSEEK_BASE_URL;
  if (tmp) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmp = '';
  }
  closeSessionDb();
});

function workspaceDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-usage-'));
  return tmp;
}

const DISCORD_ROUTING = {
  platformId: 'discord-channel',
  channelType: 'discord',
  threadId: 'thread-1',
  inReplyTo: 'm1',
  taskRun: false,
};

function job(cwd: string, totalTokens: number): DeepseekUsageJob {
  return {
    id: 'deepseek-usage-job-1',
    cwd,
    routing: DISCORD_ROUTING,
    usage: { promptTokens: 100, completionTokens: totalTokens - 100, totalTokens },
  };
}

describe('deepseek usage job', () => {
  it('returns null for non-deepseek providers', () => {
    const started = startDeepseekUsageJob({ providerName: 'codex', cwd: '/tmp', routing: DISCORD_ROUTING });
    expect(started).toBeNull();
  });

  it('returns null when routing is not a Discord channel', () => {
    const started = startDeepseekUsageJob({
      providerName: 'deepseek',
      cwd: '/tmp',
      routing: { ...DISCORD_ROUTING, channelType: 'slack', platformId: null },
    });
    expect(started).toBeNull();
  });

  it('emits one Discord report with total tokens and shared-store remaining usage', async () => {
    const cwd = workspaceDir();
    // Seed a codex row so the cross-provider line renders.
    const { updateCodexRow } = await import('./usage-store.js');
    updateCodexRow(cwd, {
      weekly_limit_used_percent: 38,
      weekly_limit_remaining_percent: 62,
      captured_at: new Date().toISOString(),
    });

    const started = startDeepseekUsageJob({ providerName: 'deepseek', cwd, routing: DISCORD_ROUTING });
    expect(started).not.toBeNull();
    await finishDeepseekUsageJob(started ? { ...started, usage: { promptTokens: 100, completionTokens: 1701, totalTokens: 1801 } } : null);

    const rows = getOutboundDb().prepare("SELECT * FROM messages_out WHERE kind = 'chat'").all() as Array<{
      channel_type: string | null;
      platform_id: string | null;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('discord');
    expect(rows[0].platform_id).toBe('discord-channel');
    const text = JSON.parse(rows[0].content).text as string;
    expect(text).toContain('total tokens: 1,801');
    expect(text).toContain('Codex weekly limit remaining: 62%');
  });

  it('writes an audit snapshot and updates the shared store', async () => {
    const cwd = workspaceDir();
    setDeepseekBalanceFetcherForTest(async () => ({ currency: 'USD', total_balance: '12.40' }));
    await finishDeepseekUsageJob(job(cwd, 500));
    const snapshots = fs.readdirSync(path.join(cwd, '.nanoclaw/deepseek-usage'));
    expect(snapshots.some((name) => name.endsWith('.json') && name !== 'cumulative.json')).toBe(true);
    const store = readUsageStore(cwd);
    expect(store.deepseek?.cumulative_total_tokens).toBe(500);
    expect(store.deepseek?.balance?.total_balance).toBe('12.40');
  });

  it('does nothing for a job with zero usage', async () => {
    const cwd = workspaceDir();
    await finishDeepseekUsageJob({ ...job(cwd, 0), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    const rows = getOutboundDb().prepare('SELECT * FROM messages_out').all();
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(path.join(cwd, '.nanoclaw/deepseek-usage'))).toBe(false);
  });

  it('formats total tokens and remaining usage for the report', () => {
    const cwd = workspaceDir();
    const text = formatDeepseekUsage(job(cwd, 1801));
    expect(text).toContain('total tokens: 1,801');
    expect(text).toContain('DeepSeek balance remaining: unavailable');
  });
});

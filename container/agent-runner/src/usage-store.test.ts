import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatRemainingUsage,
  readUsageStore,
  updateCodexRow,
  updateDeepseekRow,
  usageStorePath,
  writeUsageStore,
} from './usage-store.js';

let tmp = '';

afterEach(() => {
  if (tmp) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmp = '';
  }
});

function workspaceDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
  return tmp;
}

describe('shared usage store', () => {
  it('round-trips codex and deepseek rows independently', () => {
    const cwd = workspaceDir();
    updateCodexRow(cwd, {
      weekly_limit_used_percent: 38,
      weekly_limit_remaining_percent: 62,
      captured_at: new Date().toISOString(),
    });
    updateDeepseekRow(cwd, {
      cumulative_total_tokens: 123456,
      balance: { currency: 'USD', total_balance: '12.40' },
      captured_at: new Date().toISOString(),
    });

    const store = readUsageStore(cwd);
    expect(store.codex?.weekly_limit_remaining_percent).toBe(62);
    expect(store.deepseek?.balance?.total_balance).toBe('12.40');
    expect(fs.existsSync(usageStorePath(cwd))).toBe(true);
  });

  it('does not let one provider clobber the other', () => {
    const cwd = workspaceDir();
    updateCodexRow(cwd, {
      weekly_limit_used_percent: 38,
      weekly_limit_remaining_percent: 62,
      captured_at: new Date().toISOString(),
    });
    updateDeepseekRow(cwd, {
      cumulative_total_tokens: 1,
      balance: null,
      captured_at: new Date().toISOString(),
    });

    // A second codex write leaves the deepseek row intact.
    updateCodexRow(cwd, {
      weekly_limit_used_percent: 50,
      weekly_limit_remaining_percent: 50,
      captured_at: new Date().toISOString(),
    });
    const store = readUsageStore(cwd);
    expect(store.codex?.weekly_limit_remaining_percent).toBe(50);
    expect(store.deepseek?.cumulative_total_tokens).toBe(1);
  });

  it('renders both remaining-usage lines when both rows are fresh', () => {
    const cwd = workspaceDir();
    updateCodexRow(cwd, {
      weekly_limit_used_percent: 38,
      weekly_limit_remaining_percent: 62,
      captured_at: new Date().toISOString(),
    });
    updateDeepseekRow(cwd, {
      cumulative_total_tokens: 123456,
      balance: { currency: 'USD', total_balance: '12.40' },
      captured_at: new Date().toISOString(),
    });

    const lines = formatRemainingUsage(cwd);
    expect(lines.join('\n')).toContain('Codex weekly limit remaining: 62%');
    expect(lines.join('\n')).toContain('DeepSeek balance remaining: USD 12.40');
    // $12.40 at $0.28/M output ≈ 44,285,714 tokens remaining.
    expect(lines.join('\n')).toContain('44,285,714 tokens remaining');
  });

  it('renders unavailable for a stale or missing row without blocking', () => {
    const cwd = workspaceDir();
    // No rows at all.
    const empty = formatRemainingUsage(cwd);
    expect(empty.join('\n')).toContain('Codex weekly limit remaining: unavailable');
    expect(empty.join('\n')).toContain('DeepSeek balance remaining: unavailable');

    // A stale codex row still yields an unavailable line, and the fresh
    // deepseek row still shows.
    writeUsageStore(cwd, {
      schema_version: 'usage-store.v1',
      updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      codex: {
        weekly_limit_used_percent: 38,
        weekly_limit_remaining_percent: 62,
        captured_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      deepseek: {
        cumulative_total_tokens: 5,
        balance: { currency: 'USD', total_balance: '1.00' },
        captured_at: new Date().toISOString(),
      },
    });
    const lines = formatRemainingUsage(cwd);
    expect(lines.join('\n')).toContain('Codex weekly limit remaining: unavailable');
    expect(lines.join('\n')).toContain('DeepSeek balance remaining: USD 1.00');
  });

  it('ignores an unreadable or wrong-schema file', () => {
    const cwd = workspaceDir();
    fs.mkdirSync(path.join(cwd, '.nanoclaw'), { recursive: true });
    fs.writeFileSync(usageStorePath(cwd), 'not json');
    expect(readUsageStore(cwd)).toEqual({ schema_version: 'usage-store.v1', updated_at: '' });
    fs.writeFileSync(usageStorePath(cwd), JSON.stringify({ schema_version: 'other' }));
    expect(readUsageStore(cwd).schema_version).toBe('usage-store.v1');
  });
});

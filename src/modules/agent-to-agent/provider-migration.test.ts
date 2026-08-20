import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { wakeContainer, restartAgentGroupContainers, writeSessionMessage } = vi.hoisted(() => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  restartAgentGroupContainers: vi.fn().mockReturnValue(1),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({ wakeContainer: (...args: unknown[]) => wakeContainer(...args) }));
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: (...args: unknown[]) => restartAgentGroupContainers(...args),
}));
vi.mock('../../session-manager.js', () => ({
  resolveSession: (agentGroupId: string) => ({
    session: { id: `system-${agentGroupId}`, agent_group_id: agentGroupId },
    created: true,
  }),
  writeSessionMessage: (...args: unknown[]) => writeSessionMessage(...args),
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { GROUPS_DIR } from '../../config.js';
import fs from 'fs';
import path from 'path';
import type { AgentGroup } from '../../types.js';
import {
  HANDOFF_FILENAME,
  abortProviderMigration,
  getProviderMigrationStatus,
  observeProviderHandoff,
  startProviderSwitch,
  sweepExpiredProviderMigrations,
  validateProviderSwitch,
} from './provider-migration.js';

const AGENT = 'ag-test';
const group = (id: string): AgentGroup => ({
  id,
  name: id,
  folder: id,
  agent_provider: null,
  created_at: new Date().toISOString(),
});

function seedConfig(provider = 'codex', model: string | null = null): void {
  createContainerConfig({
    agent_group_id: AGENT,
    provider,
    model,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify({}),
    packages_apt: JSON.stringify([]),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group',
    timezone: null,
    updated_at: new Date().toISOString(),
  });
}

describe('provider migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMigrations(initTestDb());
    createAgentGroup(group(AGENT));
    seedConfig();
  });
  afterEach(() => {
    closeDb();
    try {
      fs.rmSync(path.join(GROUPS_DIR, AGENT), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects a switch to the current provider or an unknown one', () => {
    expect(() => validateProviderSwitch(AGENT, 'codex')).toThrow(/already on provider/);
    expect(() => validateProviderSwitch(AGENT, 'claude')).toThrow(/Unsupported target provider/);
  });

  it('starts a switch to deepseek and dispatches a handoff request', () => {
    const started = startProviderSwitch(AGENT, 'deepseek');
    expect(started.to_provider).toBe('deepseek');
    expect(started.state).toBe('requesting_handoff');
    expect(writeSessionMessage).toHaveBeenCalled();
    expect(wakeContainer).toHaveBeenCalled();
    expect(getContainerConfig(AGENT)!.provider).toBe('codex');
  });

  it('refuses a second switch while one is pending', () => {
    startProviderSwitch(AGENT, 'deepseek');
    expect(() => startProviderSwitch(AGENT, 'deepseek')).toThrow(/already has a pending provider migration/);
  });

  it('ignores unrelated outbound messages while awaiting handoff', () => {
    startProviderSwitch(AGENT, 'deepseek');
    expect(observeProviderHandoff(AGENT, JSON.stringify({ text: 'just a reply' }))).toBe(false);
  });

  it('fails the migration when the ready marker arrives without a readable handoff file', () => {
    startProviderSwitch(AGENT, 'deepseek');
    expect(observeProviderHandoff(AGENT, JSON.stringify({ text: 'HANDOFF_READY' }))).toBe(true);
    const status = getProviderMigrationStatus(AGENT);
    expect(status.state).toBe('failed');
    expect(status.failed_reason).toMatch(/handoff file is missing/);
  });

  it('switches provider and restarts with the handoff when the file and marker are present', () => {
    fs.mkdirSync(path.join(GROUPS_DIR, AGENT), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, AGENT, HANDOFF_FILENAME),
      'Continue the project: the requirements spec is in docs/.',
    );
    startProviderSwitch(AGENT, 'deepseek');
    expect(observeProviderHandoff(AGENT, JSON.stringify({ text: 'HANDOFF_READY' }))).toBe(true);

    const config = getContainerConfig(AGENT)!;
    expect(config.provider).toBe('deepseek');
    expect(config.model).toBe('deepseek-v4-flash');
    expect(restartAgentGroupContainers).toHaveBeenCalledWith(
      AGENT,
      expect.stringContaining('provider migration'),
      expect.stringContaining('requirements spec is in docs'),
    );
    expect(getProviderMigrationStatus(AGENT).state).toBe('switched');
  });

  it('switches back to codex and clears the deepseek model', () => {
    getDb()
      .prepare('UPDATE container_configs SET provider=?, model=? WHERE agent_group_id=?')
      .run('deepseek', 'deepseek-v4-flash', AGENT);
    fs.mkdirSync(path.join(GROUPS_DIR, AGENT), { recursive: true });
    fs.writeFileSync(path.join(GROUPS_DIR, AGENT, HANDOFF_FILENAME), 'handoff back');
    startProviderSwitch(AGENT, 'codex');
    expect(observeProviderHandoff(AGENT, 'HANDOFF_READY')).toBe(true);
    expect(getContainerConfig(AGENT)!.provider).toBe('codex');
    expect(getContainerConfig(AGENT)!.model).toBeNull();
  });

  it('aborts a pending migration without changing config', () => {
    startProviderSwitch(AGENT, 'deepseek');
    expect(abortProviderMigration(AGENT).ok).toBe(true);
    expect(getProviderMigrationStatus(AGENT).state).toBe('aborted');
    expect(getContainerConfig(AGENT)!.provider).toBe('codex');
    expect(() => startProviderSwitch(AGENT, 'deepseek')).not.toThrow();
  });

  it('expires a migration whose handoff never arrived', () => {
    startProviderSwitch(AGENT, 'deepseek');
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    getDb().prepare('UPDATE provider_migrations SET created_at=? WHERE agent_group_id=?').run(expired, AGENT);
    expect(sweepExpiredProviderMigrations()).toBe(1);
    expect(getProviderMigrationStatus(AGENT).state).toBe('failed');
  });

  it('never surfaces the raw handoff content in status', () => {
    fs.mkdirSync(path.join(GROUPS_DIR, AGENT), { recursive: true });
    fs.writeFileSync(path.join(GROUPS_DIR, AGENT, HANDOFF_FILENAME), 'secret handoff body');
    startProviderSwitch(AGENT, 'deepseek');
    observeProviderHandoff(AGENT, JSON.stringify({ text: 'HANDOFF_READY' }));
    const status = getProviderMigrationStatus(AGENT);
    expect(JSON.stringify(status)).not.toContain('secret handoff body');
  });
});

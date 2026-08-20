import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notifications, writeDestinations } = vi.hoisted(() => ({
  notifications: vi.fn(),
  writeDestinations: vi.fn(),
}));

vi.mock('../approvals/index.js', () => ({
  notifyAgent: (...args: unknown[]) => notifications(...args),
  registerApprovalHandler: vi.fn(),
  registerApprovalResolvedHandler: vi.fn(),
  requestApproval: vi.fn(),
}));
vi.mock('./write-destinations.js', () => ({ writeDestinations: (...args: unknown[]) => writeDestinations(...args) }));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import type { AgentGroup, Session } from '../../types.js';
import { issueRootGrant, revokeGrant } from './capabilities.js';
import { COPILOT_FACTORY_GROUP_ID, handleFactoryAction } from './factory.js';

const TARGET = 'ag-managed';
const SECOND_TARGET = 'ag-second';
const OUTSIDER = 'ag-outsider';
const CHANNEL = 'discord:1529768980787757106:1533032647809306735';
const session = { id: 'sess-copilot', agent_group_id: COPILOT_FACTORY_GROUP_ID } as Session;

function group(id: string): AgentGroup {
  return { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() };
}
function enroll(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO factory_managed_agents
       (agent_group_id, factory_parent_group_id, template_id, instruction_revision, enrolled_at, enrolled_by_owner_id)
       VALUES (?, ?, 'reviewer', 'sha256:test', ?, NULL)`,
    )
    .run(id, COPILOT_FACTORY_GROUP_ID, new Date().toISOString());
}
function grant(target = TARGET, channel = CHANNEL): string {
  return issueRootGrant(
    COPILOT_FACTORY_GROUP_ID,
    {
      resourceType: 'channel',
      resourceId: channel,
      action: 'wire-descendant',
      constraints: { descendant_agent_group_id: target },
    },
    'owner',
  );
}
function result(): Record<string, unknown> {
  const text = notifications.mock.calls.at(-1)?.[1] as string;
  return JSON.parse(text.replace(/^Factory result: /, '')) as Record<string, unknown>;
}
async function wire(target = TARGET, channel = CHANNEL): Promise<void> {
  await handleFactoryAction(
    { action: 'factory.wire_agent_channel', agent_group_id: target, channel_type: 'discord', platform_id: channel },
    session,
  );
}

describe('factory managed-agent Discord wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMigrations(initTestDb());
    for (const id of [COPILOT_FACTORY_GROUP_ID, TARGET, SECOND_TARGET, OUTSIDER]) createAgentGroup(group(id));
    enroll(TARGET);
    enroll(SECOND_TARGET);
    createSession({
      id: 'sess-target',
      agent_group_id: TARGET,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'openai-compatible',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(closeDb);

  it('creates one fixed-policy route with a host grant and projects it to live sessions', async () => {
    grant();
    await wire();
    expect(result()).toMatchObject({ ok: true, status: 'wired', agent_group_id: TARGET, platform_id: CHANNEL });
    const mg = getDb().prepare('SELECT * FROM messaging_groups WHERE platform_id=?').get(CHANNEL) as Record<
      string,
      unknown
    >;
    expect(mg).toMatchObject({ channel_type: 'discord', is_group: 1, unknown_sender_policy: 'strict' });
    const route = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id=?')
      .get(mg.id) as Record<string, unknown>;
    expect(route).toMatchObject({
      agent_group_id: TARGET,
      engage_mode: 'mention-sticky',
      sender_scope: 'known',
      session_mode: 'per-thread',
      threads: 1,
    });
    expect(
      getDb()
        .prepare("SELECT local_name FROM agent_destinations WHERE agent_group_id=? AND target_type='channel'")
        .get(TARGET),
    ).toMatchObject({ local_name: 'discord' });
    expect(writeDestinations).toHaveBeenCalledWith(TARGET, 'sess-target');
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS count FROM factory_audit_events WHERE operation='factory.wire_agent_channel' AND outcome='allowed'",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    await handleFactoryAction({ action: 'factory.list_channel_wirings', agent_group_id: TARGET }, session);
    expect(result()).toMatchObject({
      ok: true,
      wirings: [expect.objectContaining({ agent_group_id: TARGET, platform_id: CHANNEL })],
    });
    await handleFactoryAction({ action: 'factory.list_channel_wirings', agent_group_id: OUTSIDER }, session);
    expect(result()).toMatchObject({ ok: false, error: 'Managed agent not found.' });
  });

  it('is idempotent and denies a second responder for the same channel', async () => {
    grant();
    await wire();
    await wire();
    expect(result()).toMatchObject({ ok: true, status: 'wired' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM factory_channel_wirings').get()).toMatchObject({ count: 1 });
    grant(SECOND_TARGET);
    await wire(SECOND_TARGET);
    expect(result()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already has a factory-managed responder/),
    });
  });

  it('denies malformed IDs, DMs, unrelated agents, and missing exact grants before mutation', async () => {
    await wire();
    expect(result()).toMatchObject({ ok: false, error: expect.stringMatching(/Capability denied/) });
    await handleFactoryAction(
      {
        action: 'factory.wire_agent_channel',
        agent_group_id: TARGET,
        channel_type: 'discord',
        platform_id: 'discord:@me:123456',
      },
      session,
    );
    expect(result()).toMatchObject({ ok: false, error: expect.stringMatching(/canonical Discord/) });
    grant(OUTSIDER);
    await wire(OUTSIDER);
    expect(result()).toMatchObject({ ok: false, error: 'Managed agent not found.' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM factory_channel_wirings').get()).toMatchObject({ count: 0 });
  });

  it('unwires only its exact route, preserves unrelated routes, and fails closed after revocation', async () => {
    const root = grant();
    await wire();
    createMessagingGroup({
      id: 'unrelated-channel',
      channel_type: 'discord',
      platform_id: 'discord:1529768980787757106:1533671865481171045',
      instance: 'discord',
      name: 'other',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(
        "INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, 'other', 'channel', 'unrelated-channel', ?)",
      )
      .run(TARGET, new Date().toISOString());
    revokeGrant(root, 'owner');
    await handleFactoryAction(
      { action: 'factory.unwire_agent_channel', agent_group_id: TARGET, channel_type: 'discord', platform_id: CHANNEL },
      session,
    );
    expect(result()).toMatchObject({ ok: false, error: expect.stringMatching(/Capability denied/) });
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM factory_channel_wirings WHERE revoked_at IS NULL').get(),
    ).toMatchObject({ count: 1 });

    grant();
    await handleFactoryAction(
      { action: 'factory.unwire_agent_channel', agent_group_id: TARGET, channel_type: 'discord', platform_id: CHANNEL },
      session,
    );
    expect(result()).toMatchObject({ ok: true, status: 'unwired' });
    expect(
      getDb().prepare('SELECT * FROM agent_destinations WHERE agent_group_id=? AND local_name=?').get(TARGET, 'other'),
    ).toBeDefined();
    expect(getDb().prepare('SELECT * FROM messaging_groups WHERE id=?').get('unrelated-channel')).toBeDefined();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toMatchObject({ count: 0 });
  });
});

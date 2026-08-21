import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createProject, resolveProjectRecipient } from './projects.js';

const now = () => new Date().toISOString();
const addGroup = (id: string) =>
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
const channel = 'discord:1529768980787757106:1533032647809306735';

describe('project-channel factory routing state', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    addGroup('requirements');
    addGroup('codex');
    addGroup('junior');
  });
  afterEach(closeDb);

  it('does not take over a pre-existing singleton channel', () => {
    createMessagingGroup({
      id: 'singleton',
      channel_type: 'discord',
      platform_id: channel,
      instance: 'discord',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    expect(() => createProject('monitoring-ui', 'requirements', channel)).toThrow(/will not take it over/);
  });

  it('binds an exact alias to one child and keeps the thread isolated', () => {
    const project = createProject('monitoring-ui', 'requirements', channel);
    const insert = getDb().prepare(
      `INSERT INTO project_agents
       (project_id, agent_group_id, parent_agent_group_id, role_id, alias, parent_local_name, child_parent_local_name, report_destination_local_name, created_at)
       VALUES (?, ?, 'requirements', 'codex', ?, ?, 'parent', 'project', ?)`,
    );
    insert.run(project.project_id, 'codex', 'codex', 'codex', now());
    insert.run(project.project_id, 'junior', 'junior', 'junior', now());

    expect(resolveProjectRecipient(project.messaging_group_id, 'ordinary intake', 'thread-1')).toBeUndefined();
    expect(resolveProjectRecipient(project.messaging_group_id, '@codex implement endpoint', 'thread-1')).toBe('codex');
    // A bound thread stays with the addressed child; it does not fan out or
    // jump to the other child merely because another alias appears later.
    expect(resolveProjectRecipient(project.messaging_group_id, '@junior follow-up', 'thread-1')).toBe('codex');
    expect(resolveProjectRecipient(project.messaging_group_id, '@junior separate thread', 'thread-2')).toBe('junior');
  });
});

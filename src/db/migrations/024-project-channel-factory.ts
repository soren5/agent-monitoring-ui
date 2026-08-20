import type { Migration } from './index.js';

/** Deterministic ownership and routing state for shared project channels. */
export const migration024: Migration = {
  version: 24,
  name: 'project-channel-factory',
  up(db) {
    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_parent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX idx_projects_live_channel ON projects(channel_type, platform_id) WHERE closed_at IS NULL;
      CREATE TABLE project_agents (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        role_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        parent_local_name TEXT NOT NULL,
        child_parent_local_name TEXT NOT NULL,
        report_destination_local_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY(project_id, agent_group_id)
      );
      CREATE UNIQUE INDEX idx_project_agents_live_alias ON project_agents(project_id, alias) WHERE removed_at IS NULL;
      CREATE TABLE project_thread_bindings (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        thread_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, thread_id)
      );
      CREATE TABLE project_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        caller_group_id TEXT NOT NULL,
        project_id TEXT,
        target_group_id TEXT,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_hash TEXT NOT NULL
      );
    `);
  },
};

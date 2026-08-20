import type { Migration } from './index.js';

/** Owner-approved contracts and redacted lifecycle evidence for provisioned agents. */
export const migration026: Migration = {
  version: 26,
  name: 'agent-provisioning',
  up(db) {
    db.exec(`
      CREATE TABLE agent_provision_requests (
        request_id TEXT PRIMARY KEY,
        parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        project_id TEXT REFERENCES projects(project_id),
        template_id TEXT NOT NULL,
        template_revision TEXT NOT NULL,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        requested_actions_json TEXT NOT NULL,
        instruction_overlay TEXT NOT NULL DEFAULT '',
        repository_id TEXT,
        channel_type TEXT,
        platform_id TEXT,
        channel_mode TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','provisioned','failed')),
        owner_approval_id TEXT,
        provisioned_child_group_id TEXT REFERENCES agent_groups(id),
        failure_category TEXT,
        projection_state TEXT NOT NULL DEFAULT 'ready' CHECK(projection_state IN ('ready','pending')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE UNIQUE INDEX idx_agent_provision_active_name
        ON agent_provision_requests(parent_agent_group_id, normalized_name)
        WHERE state IN ('pending','approved','provisioned');
      CREATE INDEX idx_agent_provision_parent_created
        ON agent_provision_requests(parent_agent_group_id, created_at);

      CREATE TABLE agent_provision_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        request_id TEXT REFERENCES agent_provision_requests(request_id),
        caller_group_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_hash TEXT NOT NULL
      );
      CREATE INDEX idx_agent_provision_audit_request
        ON agent_provision_audit_events(request_id, created_at);

      CREATE TABLE agent_lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        state TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX idx_agent_lifecycle_agent_created
        ON agent_lifecycle_events(agent_group_id, created_at);
    `);
  },
};

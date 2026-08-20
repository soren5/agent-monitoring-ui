import type { Migration } from './index.js';

/** Generic, host-owned ancestry for autonomous agent provisioning. */
export const migration025: Migration = {
  version: 25,
  name: 'agent-relations',
  up(db) {
    db.exec(`
      CREATE TABLE agent_relations (
        child_agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        root_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        project_id TEXT REFERENCES projects(project_id),
        depth INTEGER NOT NULL CHECK(depth >= 1 AND depth <= 16),
        created_by_provision_request_id TEXT,
        created_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE INDEX idx_agent_relations_parent_live
        ON agent_relations(parent_agent_group_id, created_at) WHERE removed_at IS NULL;
      CREATE INDEX idx_agent_relations_root_live
        ON agent_relations(root_agent_group_id, created_at) WHERE removed_at IS NULL;

      CREATE TABLE agent_relation_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        caller_group_id TEXT NOT NULL,
        child_agent_group_id TEXT,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_hash TEXT NOT NULL
      );
      CREATE INDEX idx_agent_relation_audit_created
        ON agent_relation_audit_events(created_at);

      INSERT OR IGNORE INTO agent_relations
        (child_agent_group_id, parent_agent_group_id, root_agent_group_id, depth, created_at)
      SELECT agent_group_id, factory_parent_group_id, factory_parent_group_id, 1, enrolled_at
      FROM factory_managed_agents;
    `);
  },
};

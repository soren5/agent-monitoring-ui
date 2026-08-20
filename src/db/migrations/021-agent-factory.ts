import type { Migration } from './index.js';

/** Host-owned ownership and audit records for the Copilot Agent Factory. */
export const migration021: Migration = {
  version: 21,
  name: 'agent-factory',
  up(db) {
    db.exec(`
      CREATE TABLE factory_managed_agents (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        factory_parent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        template_id TEXT NOT NULL,
        instruction_revision TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        enrolled_by_owner_id TEXT
      );
      CREATE INDEX idx_factory_managed_parent ON factory_managed_agents(factory_parent_group_id);

      CREATE TABLE factory_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        caller_group_id TEXT NOT NULL,
        target_group_id TEXT,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        resulting_revision TEXT,
        approval_id TEXT
      );
      CREATE INDEX idx_factory_audit_caller_created ON factory_audit_events(caller_group_id, created_at);
    `);
  },
};

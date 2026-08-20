import type { Migration } from './index.js';

/** Immutable-provenance grants evaluated only by the host authorization kernel. */
export const migration022: Migration = {
  version: 22,
  name: 'capability-grants',
  up(db) {
    db.exec(`
      CREATE TABLE capability_grants (
        grant_id TEXT PRIMARY KEY,
        subject_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL DEFAULT '{}',
        parent_grant_id TEXT REFERENCES capability_grants(grant_id),
        issued_by_principal_id TEXT NOT NULL,
        issued_by_owner_id TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX idx_capability_grants_subject ON capability_grants(subject_agent_group_id);
      CREATE INDEX idx_capability_grants_parent ON capability_grants(parent_grant_id);

      CREATE TABLE capability_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        subject_agent_group_id TEXT NOT NULL,
        grant_id TEXT,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
    `);
  },
};

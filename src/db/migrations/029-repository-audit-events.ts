import type { Migration } from './index.js';

/** Append-only redacted evidence for credential-free repository broker calls. */
export const migration029: Migration = {
  version: 29,
  name: 'repository-audit-events',
  up(db) {
    db.exec(`
      CREATE TABLE repository_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        caller_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        repository_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_hash TEXT NOT NULL
      );
      CREATE INDEX idx_repository_audit_events_caller_created
        ON repository_audit_events(caller_group_id, created_at);
    `);
  },
};

import type { Migration } from './index.js';

/** Reversible provider-switch contracts: host-owned handoff + switch state. */
export const migration032: Migration = {
  version: 32,
  name: 'provider-migrations',
  up(db) {
    db.exec(`
      CREATE TABLE provider_migrations (
        migration_id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        from_provider TEXT NOT NULL,
        to_provider TEXT NOT NULL,
        to_model TEXT,
        state TEXT NOT NULL CHECK(state IN ('requesting_handoff','switching','switched','failed','aborted')),
        handoff_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        failed_reason TEXT
      );
      CREATE UNIQUE INDEX idx_provider_migrations_active
        ON provider_migrations(agent_group_id)
        WHERE state IN ('requesting_handoff','switching');
      CREATE INDEX idx_provider_migrations_group
        ON provider_migrations(agent_group_id, created_at);

      CREATE TABLE provider_migration_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        migration_id TEXT REFERENCES provider_migrations(migration_id),
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX idx_provider_migration_audit_agent
        ON provider_migration_audit_events(agent_group_id, created_at);
    `);
  },
};

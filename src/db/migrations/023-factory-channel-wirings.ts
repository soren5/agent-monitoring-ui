import type { Migration } from './index.js';

/**
 * Host-owned provenance for factory-created channel routes. This permits
 * precise, idempotent unwiring without treating arbitrary CLI wiring rows as
 * factory authority.
 */
export const migration023: Migration = {
  version: 23,
  name: 'factory-channel-wirings',
  up(db) {
    db.exec(`
      CREATE TABLE factory_channel_wirings (
        wiring_id TEXT PRIMARY KEY,
        factory_parent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
        destination_local_name TEXT NOT NULL,
        created_messaging_group INTEGER NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX idx_factory_channel_agent_live
        ON factory_channel_wirings(agent_group_id, channel_type, platform_id)
        WHERE revoked_at IS NULL;
      CREATE UNIQUE INDEX idx_factory_channel_one_live_responder
        ON factory_channel_wirings(channel_type, platform_id)
        WHERE revoked_at IS NULL;
      CREATE INDEX idx_factory_channel_wirings_parent
        ON factory_channel_wirings(factory_parent_group_id, agent_group_id);
    `);
  },
};

import type { Migration } from './index.js';

/** Immutable broker scopes resolved as part of an approved provisioning contract. */
export const migration028: Migration = {
  version: 28,
  name: 'agent-repository-profiles',
  up(db) {
    db.exec(`
      CREATE TABLE agent_repository_profiles (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
        repository_id TEXT NOT NULL,
        branch_prefix TEXT NOT NULL,
        head_prefix TEXT NOT NULL,
        allowed_actions_json TEXT NOT NULL,
        merge_policy TEXT NOT NULL CHECK(merge_policy IN ('disabled','parent-review','automated-checks')),
        provision_request_id TEXT NOT NULL REFERENCES agent_provision_requests(request_id),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX idx_agent_repository_profiles_repository
        ON agent_repository_profiles(repository_id) WHERE revoked_at IS NULL;
    `);
  },
};

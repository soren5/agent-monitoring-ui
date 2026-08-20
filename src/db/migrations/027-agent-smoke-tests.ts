import type { Migration } from './index.js';

/** Fixed-fixture, redacted evidence for provisioned-agent health checks. */
export const migration027: Migration = {
  version: 27,
  name: 'agent-smoke-tests',
  up(db) {
    db.exec(`
      CREATE TABLE agent_smoke_test_results (
        smoke_test_id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        fixture_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','passed','failed','timeout','backend_unhealthy')),
        output_redacted TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_agent_smoke_test_latest
        ON agent_smoke_test_results(agent_group_id, started_at DESC);
    `);
  },
};

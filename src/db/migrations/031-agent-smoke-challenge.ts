import type { Migration } from './index.js';

/** Host-verifiable per-run smoke challenge; the plaintext never persists. */
export const migration031: Migration = {
  version: 31,
  name: 'agent-smoke-challenge',
  up(db) {
    db.exec(`
      ALTER TABLE agent_smoke_test_results ADD COLUMN expected_response_hash TEXT;
      CREATE INDEX idx_agent_smoke_running ON agent_smoke_test_results(state, started_at)
        WHERE state = 'running';
    `);
  },
};

import type { Migration } from './index.js';

/** Forward-only durable state machine for commands accepted by migration 034. */
export const migration036: Migration = {
  version: 36,
  name: 'monitor-command-state-machine',
  up(db) {
    db.exec(`
      ALTER TABLE monitor_command_outcomes ADD COLUMN agent_group_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE monitor_command_outcomes ADD COLUMN body TEXT NOT NULL DEFAULT '';
      ALTER TABLE monitor_command_outcomes ADD COLUMN state TEXT NOT NULL DEFAULT 'delivered'
        CHECK(state IN ('accepted','delivering','delivered','failed','retryable'));
      ALTER TABLE monitor_command_outcomes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_monitor_commands_recovery
        ON monitor_command_outcomes(state, updated_at);
    `);
  },
};

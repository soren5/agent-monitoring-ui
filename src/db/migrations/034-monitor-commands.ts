import type { Migration } from './index.js';

/** Durable idempotency outcomes for local monitor message commands. */
export const migration033: Migration = {
  version: 33,
  name: 'monitor-command-outcomes',
  up(db) {
    db.exec(`
      CREATE TABLE monitor_command_outcomes (
        command_id TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

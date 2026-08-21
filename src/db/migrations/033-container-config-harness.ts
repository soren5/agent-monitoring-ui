import type { Migration } from './index.js';

/**
 * Per-group harness tool surface for harness-backed providers (opencode/codex).
 * `implementation` gives a coding agent shell + filesystem access to its
 * isolated checkout; NULL/'read-only' keeps the restricted specialist surface.
 */
export const migration033: Migration = {
  version: 33,
  name: 'container-config-harness',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN harness TEXT;`);
  },
};

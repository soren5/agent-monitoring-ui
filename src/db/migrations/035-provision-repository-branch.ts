import type { Migration } from './index.js';

/**
 * Structured target branch for a provisioned repository child. The parent
 * declares the exact branch prefix it wants to delegate so provisioning does
 * not have to guess which of its (possibly several) repository grants applies.
 */
export const migration035: Migration = {
  version: 35,
  name: 'provision-repository-branch',
  up(db) {
    db.exec(`ALTER TABLE agent_provision_requests ADD COLUMN repository_branch_prefix TEXT`);
  },
};

import type { Migration } from './index.js';

/** Immutable record that an approved requirements-parent also bootstrapped a project. */
export const migration030: Migration = {
  version: 30,
  name: 'provisioning-project-bootstrap',
  up(db) {
    db.exec(`
      ALTER TABLE agent_provision_requests ADD COLUMN project_bootstrap_id TEXT;
      CREATE UNIQUE INDEX idx_agent_provision_project_bootstrap
        ON agent_provision_requests(project_bootstrap_id)
        WHERE project_bootstrap_id IS NOT NULL;
    `);
  },
};

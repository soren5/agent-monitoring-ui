import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { delegateGrant, findEffectiveGrant, issueRootGrant, revokeGrant } from './capabilities.js';

const repo = 'soren5/agent-monitoring-ui';
const add = (id: string) =>
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
describe('capability attenuation', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    add('parent');
    add('child');
  });
  afterEach(closeDb);
  it('delegates only a constrained subset and revokes descendants', () => {
    issueRootGrant(
      'parent',
      {
        resourceType: 'repository',
        resourceId: repo,
        action: 'branch-write',
        constraints: { branch_prefix: 'feature/' },
      },
      'owner',
    );
    const child = delegateGrant('parent', 'child', {
      resourceType: 'repository',
      resourceId: repo,
      action: 'branch-write',
      constraints: { branch_prefix: 'feature/child-' },
    });
    expect(
      findEffectiveGrant('child', {
        resourceType: 'repository',
        resourceId: repo,
        action: 'branch-write',
        constraints: { branch_prefix: 'feature/child-' },
      }),
    ).toBeDefined();
    expect(
      findEffectiveGrant('child', {
        resourceType: 'repository',
        resourceId: repo,
        action: 'branch-write',
        constraints: { branch_prefix: 'feature/other-' },
      }),
    ).toBeUndefined();
    revokeGrant(child, 'owner');
    expect(
      findEffectiveGrant('child', { resourceType: 'repository', resourceId: repo, action: 'branch-write' }),
    ).toBeUndefined();
  });
  it('denies a broader child request', () => {
    issueRootGrant('parent', { resourceType: 'repository', resourceId: repo, action: 'read' }, 'owner');
    expect(() =>
      delegateGrant('parent', 'child', { resourceType: 'repository', resourceId: repo, action: 'pr-create' }),
    ).toThrow(/lacks/);
  });
});

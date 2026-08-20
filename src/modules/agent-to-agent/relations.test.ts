import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createRelation, getLiveRelation, isLiveAncestor, removeRelationSubtree } from './relations.js';

const add = (id: string) =>
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });

describe('generic agent relations', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    for (const id of ['root', 'child', 'grandchild', 'sibling']) add(id);
  });
  afterEach(closeDb);

  it('creates a bounded ancestry tree without a Copilot special case', () => {
    createRelation('root', 'child');
    createRelation('child', 'grandchild');
    createRelation('root', 'sibling');
    expect(getLiveRelation('grandchild')).toMatchObject({ root_agent_group_id: 'root', depth: 2 });
    expect(isLiveAncestor('root', 'grandchild')).toBe(true);
    expect(isLiveAncestor('child', 'sibling')).toBe(false);
    expect(() => createRelation('grandchild', 'root')).toThrow(/cycle/);
  });

  it('soft-removes only a relation subtree', () => {
    createRelation('root', 'child');
    createRelation('child', 'grandchild');
    createRelation('root', 'sibling');
    expect(removeRelationSubtree('root', 'child')).toBe(2);
    expect(getLiveRelation('child')).toBeUndefined();
    expect(getLiveRelation('grandchild')).toBeUndefined();
    expect(getLiveRelation('sibling')).toBeDefined();
  });
});

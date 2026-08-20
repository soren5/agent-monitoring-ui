/** Generic host-owned agent ancestry. No container input is trusted. */
import crypto from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';

export type AgentRelation = {
  child_agent_group_id: string;
  parent_agent_group_id: string;
  root_agent_group_id: string;
  project_id: string | null;
  depth: number;
  created_by_provision_request_id: string | null;
  created_at: string;
  removed_at: string | null;
};

const now = () => new Date().toISOString();
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function audit(caller: string, child: string | null, operation: string, outcome: string, request: unknown): void {
  if (!hasTable(getDb(), 'agent_relation_audit_events')) return;
  getDb()
    .prepare(
      `INSERT INTO agent_relation_audit_events
       (created_at, caller_group_id, child_agent_group_id, operation, outcome, request_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now(), caller, child, operation, outcome, hash(request));
}

export function getLiveRelation(childId: string): AgentRelation | undefined {
  if (!hasTable(getDb(), 'agent_relations')) return undefined;
  return getDb()
    .prepare('SELECT * FROM agent_relations WHERE child_agent_group_id=? AND removed_at IS NULL')
    .get(childId) as AgentRelation | undefined;
}

/** Returns true only for a strict, live ancestor relationship. */
export function isLiveAncestor(ancestorId: string, childId: string): boolean {
  if (ancestorId === childId || !hasTable(getDb(), 'agent_relations')) return false;
  const row = getDb()
    .prepare(
      `WITH RECURSIVE ancestors(child_id, parent_id, removed_at, depth) AS (
         SELECT child_agent_group_id, parent_agent_group_id, removed_at, 1
         FROM agent_relations WHERE child_agent_group_id=?
         UNION ALL
         SELECT r.child_agent_group_id, r.parent_agent_group_id, r.removed_at, ancestors.depth + 1
         FROM agent_relations r JOIN ancestors ON r.child_agent_group_id=ancestors.parent_id
         WHERE ancestors.depth < 16
       )
       SELECT 1 FROM ancestors WHERE parent_id=? AND removed_at IS NULL LIMIT 1`,
    )
    .get(childId, ancestorId) as { 1: number } | undefined;
  return row !== undefined;
}

export function createRelation(
  parentId: string,
  childId: string,
  options: { projectId?: string | null; provisionRequestId?: string | null } = {},
): AgentRelation {
  if (!hasTable(getDb(), 'agent_relations')) throw new Error('Agent relation storage is not installed.');
  if (parentId === childId || isLiveAncestor(childId, parentId)) {
    audit(parentId, childId, 'relation.create', 'denied', options);
    throw new Error('Agent relation would create a cycle.');
  }
  const parent = getLiveRelation(parentId);
  const root = parent?.root_agent_group_id ?? parentId;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > 16) {
    audit(parentId, childId, 'relation.create', 'denied', options);
    throw new Error('Agent relation exceeds maximum depth.');
  }
  const relation: AgentRelation = {
    child_agent_group_id: childId,
    parent_agent_group_id: parentId,
    root_agent_group_id: root,
    project_id: options.projectId ?? parent?.project_id ?? null,
    depth,
    created_by_provision_request_id: options.provisionRequestId ?? null,
    created_at: now(),
    removed_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO agent_relations
       (child_agent_group_id, parent_agent_group_id, root_agent_group_id, project_id, depth, created_by_provision_request_id, created_at)
       VALUES (@child_agent_group_id, @parent_agent_group_id, @root_agent_group_id, @project_id, @depth, @created_by_provision_request_id, @created_at)`,
    )
    .run(relation);
  audit(parentId, childId, 'relation.create', 'allowed', options);
  return relation;
}

/** Soft-removes a child relation subtree without deleting history. */
export function removeRelationSubtree(callerId: string, childId: string): number {
  if (!hasTable(getDb(), 'agent_relations')) return 0;
  const result = getDb()
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT child_agent_group_id FROM agent_relations WHERE child_agent_group_id=? AND removed_at IS NULL
         UNION ALL
         SELECT r.child_agent_group_id FROM agent_relations r JOIN subtree s ON r.parent_agent_group_id=s.id
         WHERE r.removed_at IS NULL
       )
       UPDATE agent_relations SET removed_at=? WHERE child_agent_group_id IN subtree AND removed_at IS NULL`,
    )
    .run(childId, now());
  audit(callerId, childId, 'relation.remove_subtree', 'allowed', { removed: result.changes });
  return result.changes;
}

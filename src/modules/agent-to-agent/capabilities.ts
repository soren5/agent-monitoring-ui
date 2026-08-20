/**
 * Deterministic capability kernel.  This module deliberately has no container
 * inputs: callers provide the authenticated session group and the operation
 * they want to perform; all grants and revocations live in the host database.
 */
import crypto from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';

export type CapabilityGrant = {
  grant_id: string;
  subject_agent_group_id: string;
  resource_type: string;
  resource_id: string;
  actions_json: string;
  constraints_json: string;
  parent_grant_id: string | null;
  issued_by_principal_id: string;
  issued_by_owner_id: string | null;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

export type CapabilityRequest = {
  resourceType: string;
  resourceId: string;
  action: string;
  constraints?: Record<string, unknown>;
};

const now = () => new Date().toISOString();
const parse = (value: string): Record<string, unknown> => JSON.parse(value) as Record<string, unknown>;
const actions = (grant: CapabilityGrant): string[] => JSON.parse(grant.actions_json) as string[];

function audit(subject: string, grantId: string | null, operation: string, outcome: string, detail: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO capability_audit_events
    (created_at, subject_agent_group_id, grant_id, operation, outcome, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now(), subject, grantId, operation, outcome, JSON.stringify(detail));
}

/** A requested constraint may only narrow an existing constraint, never replace it. */
export function constraintsCover(parent: Record<string, unknown>, requested: Record<string, unknown>): boolean {
  return Object.entries(requested).every(([key, value]) => {
    const allowed = parent[key];
    if ((key === 'branch_prefix' || key === 'head_prefix') && typeof allowed === 'string' && typeof value === 'string')
      return value.startsWith(allowed);
    if (Array.isArray(allowed)) return Array.isArray(value) && value.every((v) => allowed.includes(v));
    if (Array.isArray(value)) return false;
    return allowed === value;
  });
}

function live(grant: CapabilityGrant): boolean {
  return !grant.revoked_at && (!grant.expires_at || grant.expires_at > now());
}

export function findEffectiveGrant(subject: string, request: CapabilityRequest): CapabilityGrant | undefined {
  if (!hasTable(getDb(), 'capability_grants')) return undefined;
  const rows = getDb()
    .prepare(
      `SELECT * FROM capability_grants
    WHERE subject_agent_group_id=? AND resource_type=? AND resource_id=?`,
    )
    .all(subject, request.resourceType, request.resourceId) as CapabilityGrant[];
  return rows.find(
    (grant) =>
      live(grant) &&
      actions(grant).includes(request.action) &&
      constraintsCover(parse(grant.constraints_json), request.constraints ?? {}),
  );
}

/** Create a root grant from an authenticated owner operation. */
export function issueRootGrant(subject: string, request: CapabilityRequest, ownerId: string): string {
  if (!hasTable(getDb(), 'capability_grants')) throw new Error('Capability storage is not installed.');
  const grantId = `cap-${crypto.randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO capability_grants
    (grant_id, subject_agent_group_id, resource_type, resource_id, actions_json, constraints_json, parent_grant_id, issued_by_principal_id, issued_by_owner_id, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      grantId,
      subject,
      request.resourceType,
      request.resourceId,
      JSON.stringify([request.action]),
      JSON.stringify(request.constraints ?? {}),
      ownerId,
      ownerId,
      now(),
    );
  audit(subject, grantId, 'grant.issue_root', 'allowed', request);
  return grantId;
}

/** Delegation is attenuation: same resource, one already-held action, narrower constraints only. */
export function delegateGrant(parentSubject: string, childSubject: string, request: CapabilityRequest): string {
  const parent = findEffectiveGrant(parentSubject, request);
  if (!parent) {
    audit(parentSubject, null, 'grant.delegate', 'denied', request);
    throw new Error('Parent lacks requested capability.');
  }
  const grantId = `cap-${crypto.randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO capability_grants
    (grant_id, subject_agent_group_id, resource_type, resource_id, actions_json, constraints_json, parent_grant_id, issued_by_principal_id, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantId,
      childSubject,
      request.resourceType,
      request.resourceId,
      JSON.stringify([request.action]),
      JSON.stringify(request.constraints ?? {}),
      parent.grant_id,
      parentSubject,
      now(),
    );
  audit(childSubject, grantId, 'grant.delegate', 'allowed', { parent_grant_id: parent.grant_id, ...request });
  return grantId;
}

/** Revocation is recursive so a parent cannot leave a still-live descendant. */
export function revokeGrant(grantId: string, ownerId: string): number {
  const result = getDb()
    .prepare(
      `WITH RECURSIVE descendants(grant_id) AS (
      SELECT grant_id FROM capability_grants WHERE grant_id=?
      UNION ALL SELECT c.grant_id FROM capability_grants c JOIN descendants d ON c.parent_grant_id=d.grant_id
    ) UPDATE capability_grants SET revoked_at=? WHERE grant_id IN descendants AND revoked_at IS NULL`,
    )
    .run(grantId, now());
  audit(ownerId, grantId, 'grant.revoke', 'allowed', { revoked: result.changes });
  return result.changes;
}

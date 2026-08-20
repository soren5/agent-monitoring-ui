# Spec: generic hierarchical factory

## Goal

Replace Copilot-specific Factory authorization with a generic host-enforced
agent tree. Copilot is a highly privileged root, not a special case.

## Data model

```text
agent_relations(
  child_agent_group_id PRIMARY KEY, parent_agent_group_id NOT NULL,
  root_agent_group_id NOT NULL, project_id, depth NOT NULL,
  created_by_provision_request_id, removed_at
)
```

The host derives ancestry from this table. A destination or agent-provided name
is never evidence of ownership.

## Authorization

Every factory operation checks that the authenticated caller is a live ancestor
of the target, the action is covered by a live derived grant, the requested
profile is no broader than caller/project ceilings, and target/caller share the
same root/project tree.

Only owner-approved provisioning may add a relation. No API can re-parent an
existing group, adopt a singleton, or create a cross-tree relationship.

## Goal-mode implementation boundary

This is the foundation slice. Replace every `COPILOT_FACTORY_GROUP_ID` principal
check only at authorization boundaries with relation-plus-effective-grant
checks; retain it solely as legacy seed data. Do not change the existing
singleton `factory_*channel*` routing behavior in this slice.

Use a recursive, cycle-safe ancestry query. Enforce a finite template-defined
maximum depth. Soft deletion must make a relation invisible immediately and
revoke the relation subtree; it must not delete agent history or unrelated
singleton routes.

## Required verification

- Copilot, Requirements, and a delegated child each succeed only within their
  own tree when holding a grant.
- Sibling, ancestor, cross-root, and cycle attempts are denied.
- Migration preserves current enrolled agents but creates no new authority.

## Migration

Seed existing Copilot-managed agents as explicit relations. Seed Requirements
as a project root only after owner project creation. Do not infer grants from
mounts, folders, names, or Discord channels.

## Acceptance criteria

- Requirements can request a Junior/API/Test child after approval.
- A delegated Junior can request only more-restricted descendants after
  approval.
- A child cannot manage siblings or ancestors.

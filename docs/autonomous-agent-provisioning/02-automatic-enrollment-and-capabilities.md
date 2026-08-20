# Spec: automatic enrollment and capability materialization

## Goal

An approved provisioning contract must leave a child immediately manageable by
its parent without manual Factory enrollment or root-grant commands.

## Materialization

On approval the host atomically creates the group/configuration, records the
parent relation, creates reciprocal destinations, derives grants, attaches the
approved repository/channel routes, and projects destinations into live
sessions. A failure rolls back all new records and marks the request failed.

The child starts with no ambient Factory, cross-project, host, credential,
Docker, package, mount, global CLI, or access-control authority.

## Capability rule

```text
effective child grant = approved requested profile
                      ∩ parent effective grant
                      ∩ template ceiling
                      ∩ project/repository relation
```

Each grant stores its parent grant ID. Revoking a parent recursively revokes all
derived grants and deactivates related routes before the next operation.

## Read API

`factory_get_agent` returns host-derived role, template revision, parent,
capability summary, repository scope summary, routing status, and lifecycle. It
never returns grants, credentials, mounts, raw sessions, or logs.

For provisioned trees, `factory_list_agents` and `factory_get_agent` use the
same names as the singleton Factory API but are resolved from the caller's live
direct relations and derived `list-agents`/`get-status` grants. They never
consult Copilot's legacy enrollment table.

## Goal-mode implementation boundary

Implement this as the single materializer called by an approved provisioning
request. Do not retain a manual post-create enrollment path for newly created
children. Existing legacy enrollment stays read-compatible only until migrated.

Use the existing capability-grant chain and destination projection code rather
than duplicating authorization logic. The transaction must create durable rows
first; projection is retryable post-commit work whose failure is represented as
`projection_pending`, never as a silently missing route.

## Required verification

- Materialized child is immediately listed by its parent and has only derived
  grants and host-created destinations.
- Parent grant revocation recursively disables child and grandchild actions.
- Simulated projection failure is recoverable and does not broaden access.

## Acceptance criteria

- No manual enrollment is required for any approved child, including Junior.
- A child cannot receive an action absent from the parent’s effective grants.
- Removing a child removes only its subtree’s derived routes and grants.

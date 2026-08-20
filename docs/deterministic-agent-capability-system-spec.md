# Deterministic Hierarchical Agent Capability System

## Objective

Every agent may create and dispatch sub-agents. Authorization is enforced by a
trusted host kernel: a child can receive only a deterministic subset of its
parent's effective capabilities. Copilot is not an exception; it simply starts
with a broader owner-issued capability set.

## Security invariant

```text
child grant = requested grant ∩ parent effective grants ∩ system ceiling
```

If that intersection differs from the request, the host denies it before a
tool, container, filesystem, provider, or repository operation occurs.
Prompts, instructions, MCP schemas, container-local checks, and model behavior
are not authorization boundaries.

## Capability records

Each grant is a host-owned, concrete record:

```text
capability_grants(
  grant_id PRIMARY KEY,
  subject_agent_group_id,
  resource_type, resource_id,
  actions_json, constraints_json,
  parent_grant_id NULL,
  issued_by_principal_id, issued_by_owner_id NULL,
  issued_at, expires_at NULL, revoked_at NULL
)
```

Capabilities are resource/action scoped. Examples:

- repository: `read`, `branch-write(feature/*)`, `pr-create`, `pr-review`,
  `pr-merge`;
- factory relation: `create-child`, `dispatch-child`, `read-managed-status`,
  `update-managed-overlay`;
- data store: `read`, `append`, `replace-own-result`;
- model route: invoke only an allowlisted model;
- credential route: invoke only—never read, export, or refresh a credential.

An absent record is a deterministic denial. Roles are display groupings only;
they never authorize an operation.

## Delegation and lifecycle

The host authenticates the parent from its session, computes attenuation,
creates the child, stores immutable parent-grant provenance, and materializes
only the resulting child grants. Children inherit no ambient host filesystem,
network, GitHub token, mount, provider, or destination access.

Dispatch also requires an explicit parent-to-child relation grant. Messages
carry work, not capabilities. A child always executes under its own effective
grant set.

Revoking a grant invalidates every descendant grant derived from it before any
subsequent tool execution or container wake. This is a transitive host-side
state transition, not a request for children to cooperate.

## Repository workflow

```text
Requirements: repo read + branch-write(feature/*) + PR-create + PR-review + PR-merge
├─ API agent: repo read + branch-write(feature/api-*) + PR-create
├─ Local coding agent: repo read + branch-write(feature/local-*) + PR-create
└─ Test agent: repo read + PR-read + append(test-results)
```

Repository actions are host-mediated capabilities, not raw tokens in
containers. Coding children can submit PRs in their assigned branch scope but
cannot merge. Requirements may merge only if it has a currently effective
merge grant for that exact repository. Tests may append results but cannot
write source.

## Factory and observability

Any principal with a factory-relation grant may create/manage only descendants
of that relation. It may read host-derived redacted status and issue an
idempotent wake for an existing managed session. Wake injects no work, creates
no session, force-kills nothing, changes no access, and therefore needs no
rate limit or audit record.

Work-causing actions, such as smoke tests, are explicit capabilities with
deterministic constraints: fixed probe, target set, enablement, and any owner
chosen cost budget. Raw logs, transcripts, credentials, paths, container IDs,
and session IDs are never returned to agents.

## Owner grants and system ceilings

Owner approval is an authenticated external operation that creates/changes a
root grant. It is not a bypass. Until the resulting record exists, the request
is denied; replay revalidates all live constraints.

The kernel always denies raw host shell, Docker socket, arbitrary network
proxy, raw credential export, self-escalation, editing grants, granting global
CLI scope, or authorization inferred from an untrusted payload. Host-only
operations remain host-only regardless of grant ancestry.

## Audit and explainability

Grant issuance, delegation, denial, revocation, expiration, repository write,
PR operations, and capability-changing lifecycle decisions are append-only
audit events. They include grant provenance, resource/action, decision,
request hash, and timestamps—never secrets or transcript content.

The host must deterministically answer: “Why can principal X perform action A
on resource R?” with the active root-to-leaf grant chain and constraints.

## Acceptance criteria

- A parent can create and dispatch a child with only a subset of its grants.
- One extra action, resource, model, branch, expiry, mount, or credential route
  is denied before execution.
- Coding children can create only bounded PRs; test children cannot write code;
  merge requires the parent's explicit repository merge grant.
- Revoking a parent grant invalidates all descendants immediately.
- Forged system actions and direct container database writes cannot bypass the
  host authorization kernel.
- A real delegated Discord agent can diagnose/wake its descendant without
  receiving cross-group CLI or host access.

## Migration

Replace the fixed Copilot factory-principal check with a generic
factory-relation grant check. Seed existing Copilot relationships as explicit
owner-issued grants. The migration must not grant any new capability merely by
existing; every relationship is explicit and reviewable.

## Trial deployment: `soren5/agent-monitoring-ui`

The initial root grants are intentionally narrow:

- Requirements: `repository/read`, `repository/branch-write` constrained to
  `feature/requirements-`, and `repository/pr-create` constrained to the same
  head prefix.
- Copilot: `factory-relation/dispatch-child` for Requirements only.

The host GitHub App broker reads its PEM only from host configuration and
mints short-lived installation tokens in-process. Agent containers receive
request-only MCP tools; they never receive the key or a token. The trial PR
is created through this broker after the branch-prefix denial is verified.

# Autonomous agent provisioning specifications

These specifications define the control plane required for an owner to approve
only new-agent creation and optional channel binding, while agents perform all
subsequent work within deterministic host-enforced limits.

## Delivery order and dependency rule

1. [Generic hierarchical factory](04-generic-hierarchical-factory.md)
2. [Declarative agent templates](05-declarative-agent-templates.md)
3. [Local-model connectivity](09-local-model-connectivity.md)
4. [Approved provisioning contract](01-approved-provisioning-contract.md) and
   [automatic enrollment/materialization](02-automatic-enrollment-and-capabilities.md)
   as one atomic delivery unit
5. [Create, activate, and dispatch lifecycle](03-create-activate-dispatch.md)
6. [Channel binding approval](07-channel-binding-approval.md)
7. [Status, wake, and smoke tests](08-status-wake-and-smoke-tests.md)
8. [Repository and pull-request authority](06-repository-and-pr-authority.md)

Each numbered document is an independently committable goal-mode slice only
after its listed prerequisites exist. A later slice must not emulate a missing
earlier capability with a Copilot-specific exception, raw CLI access, direct
database writes, or a temporary broad grant.

The provisioning contract and materializer are deliberately one delivery unit:
approval cannot be considered complete if it leaves a child pending manual
enrollment, grant, channel wiring, or session setup.

Every project begins through an approved `requirements-parent` request with a
canonical Discord `project_bootstrap`. The host creates the shared project
channel and makes that Requirements agent its sole ordinary-message responder
in the same transaction. This is deliberately unavailable for any other
template or a nested parent.

## Shared invariants

- The host derives caller identity from the authenticated session.
- A child receives only the intersection of its request, parent grants,
  template ceiling, and owner-approved contract.
- Containers cannot alter mounts, provider configuration, credentials, Docker,
  global CLI scope, host processes, raw database records, or routing policy.
- Revocation is transitive and is checked before the next host operation.
- Decisions are append-only audited with redacted metadata and a request hash.
- Owner approval is required only for a new agent and an optional channel
  binding; normal work inside the approved tree requires no further approval.

## Goal-mode completion rule

Every implementation goal must add a migration when it persists new state,
request-only MCP tools, host-side delivery handlers, redacted audit records,
unit/integration tests for success and denial paths, and an owner activation or
migration report. It must preserve existing singleton Factory wiring and must
not deploy or grant new production authority without an explicit owner action.

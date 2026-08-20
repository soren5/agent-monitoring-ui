# Spec: create, activate, and dispatch lifecycle

## Goal

Make an approved child runnable and testable immediately. Dispatch must not
fail merely because the child has not yet received inbound chat traffic.

## Operations

`factory_activate_child` accepts only `child_agent_group_id`. The host verifies
an ancestor relation plus `activate-child`, resolves or creates one private
system session, projects destinations, and wakes it. It injects no task.

`factory_dispatch_child` accepts a child ID and bounded task. The host verifies
`dispatch-child` and descendant relation, activates the child if needed, and
writes one authenticated agent message.

`factory_provision_and_smoke_test` is a host sequence after approval: activate,
dispatch a template-defined harmless test, await a bounded result, and return
redacted status. It cannot execute caller-supplied shell commands.

## State machine

```text
provisioned → activating → ready → running → ready | failed | revoked
```

Activation is idempotent. Wake creates no public message, changes no
permissions, and does not force-kill a running session.

## Goal-mode implementation boundary

Implement activation as a dedicated host handler, not an agent CLI command.
The system session must use a reserved internal namespace that cannot collide
with platform thread IDs. Dispatch may create only this already-authorized
private session; it may not create a Discord/DM messaging group or route.

Smoke tests are template fixture IDs, not prompt text. Each fixture has a fixed
timeout, maximum output size, expected terminal condition, and redaction rule.
Timeout/connection failures produce a lifecycle event and test result, not an
unbounded retry loop.

## Required verification

- First dispatch creates exactly one private session and subsequent dispatches
  reuse it.
- Concurrent activation requests are idempotent.
- A parent cannot make a child emit a public message during activation/testing.

## Acceptance criteria

- A just-provisioned child can receive a parent task without user traffic.
- Repeated activation creates no duplicate session/container.
- A parent cannot activate or dispatch a sibling, ancestor, or unrelated group.

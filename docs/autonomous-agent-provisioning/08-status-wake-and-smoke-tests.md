# Spec: status, wake, and smoke tests

## Goal

Give an authorized parent deterministic observability to develop and debug
descendants without cross-group shell access.

## Read surface

`factory_get_status` returns a redacted lifecycle state, template revision,
provider/model identity, last transition, destination projection state, and
latest smoke-test outcome. It excludes raw container/session IDs, logs,
prompts, transcripts, mounts, and credentials.

## Control surface

- `factory_request_wake`: idempotently wakes an existing session; no task,
  public message, permission change, rate limit, or audit entry.
- `factory_run_smoke_test`: runs a template-selected fixture with bounded input
  and timeout; it returns a redacted result and stores an audit event.
- `factory_get_smoke_test`: reads the latest result for a visible descendant.

Only an ancestor holding the derived status/test grant may call these. None can
start a sibling, create an unrelated session, alter a model, or execute an
arbitrary command.

## Goal-mode implementation boundary

Use host lifecycle records as the source of truth; do not infer status from a
container name, a Discord reply, or stale session presence. `factory_request_wake`
is intentionally unaudited only after it has passed authorization, because it
is idempotent and injects no work. Status reads are audited only if the existing
audit policy requires reads; smoke-test start/result always are.

The API must distinguish `not_provisioned`, `revoked`, `projection_pending`,
and `backend_unhealthy` from ordinary stopped/running states.

## Required verification

- Wake of a stopped valid child is idempotent and produces no outbound chat.
- Status cannot disclose a sibling or unrelated child.
- Smoke test returns bounded/redacted output for pass, timeout, and backend
failure.

Each run receives a fresh opaque challenge. The fixture instructs the child to
send the exact response to its already-host-created `parent` destination. The
host stores only a hash, intercepts that one direct child-to-parent response
before ordinary agent routing, and marks it passed only on an exact match. A
different response is failed; no response within two minutes is timed out by
the host sweep. Neither a Discord message nor a model assertion can complete a
smoke test.

## Acceptance criteria

- A parent distinguishes `provisioned`, `ready`, `running`, `failed`, and
  `revoked` without host access.
- A failed local backend is visible as health data, not opaque `unknown`.

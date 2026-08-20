# Managed-Agent Observability and Controlled Wake

## Purpose

Close the operational loop for descendants enrolled in any authorized parent
agent's factory relation. A factory principal must be able to determine whether
a managed specialist can receive work, diagnose bounded runtime failures, and
request a controlled wake or smoke test without broad host access.

This slice extends the deterministic capability system. It does not alter a
principal's CLI scope or let it manage agents outside an explicit factory
relation grant.

## Scope and trust model

- **Caller:** an authenticated principal with `factory.manage` over the target
  relation.
- **Target:** an explicitly enrolled descendant of that relation. Unrelated
  groups return `not_found`.
- **Capability issuer remains responsible for:** issuing/revoking the relation
  and any persistent capability expansion. Owners issue root grants; agents
  may issue only attenuated child grants.
- **Host remains authoritative:** container-provided state, error text, actor
  identity, session IDs, and paths are never trusted or returned directly.

## Factory MCP operations

### `factory_get_runtime_status`

Input:

```json
{ "agent_group_id": "ag-..." }
```

Returns a safe, current host-derived status record:

```json
{
  "agent_group_id": "ag-...",
  "lifecycle": "ready|running|idle|no_active_session|stopped|error|unknown",
  "last_activity_at": "2026-08-02T...Z|null",
  "session": {
    "present": true,
    "container_state": "running|idle|stopped|unknown",
    "has_pending_work": false
  },
  "runtime": {
    "provider": "openai-compatible",
    "model": "google/gemma-4-12b-qat",
    "cli_scope": "disabled"
  },
  "last_failure": {
    "category": "none|container_unavailable|provider_auth|provider_unreachable|model_unavailable|timeout|execution_error|unknown",
    "observed_at": "2026-08-02T...Z|null"
  },
  "recommended_action": "send_message|request_wake|operator_attention|none"
}
```

It must not expose raw logs, stack traces, credentials, mount paths, OneCLI
data, session IDs, container IDs, message bodies, prompt/transcript content,
or arbitrary configuration JSON. `factory_list_agents` should replace its
current hard-coded `unknown` with the same lifecycle summary.

### `factory_request_wake`

Input:

```json
{ "agent_group_id": "ag-...", "reason": "bounded debugging reason" }
```

This is a narrow host lifecycle action, not a generic restart or command
runner. It may only wake an existing active session for an enrolled agent. It
must not create new destinations, create a session, modify configuration, or
inject a prompt. It returns one of `woken`, `already_running`,
`no_active_session`, or `denied`.

A wake is immediate, idempotent, and not rate-limited or audited: it merely
starts an existing stopped/idle container. It never force-kills a running
container and never adds work. If queued work already exists, processing that
work is its own pre-existing model-cost decision. `no_active_session`
instructs Copilot to use its existing permitted agent message route or ask the
owner to establish/wire a session.

### `factory_run_smoke_test`

Input:

```json
{ "agent_group_id": "ag-..." }
```

This is optional but completes a deterministic test loop. It sends one
host-owned fixed probe to an active, enrolled specialist:

> `Factory health check. Reply with exactly: FACTORY_HEALTHY`

The host returns a correlation ID. `factory_get_runtime_status` exposes only
the probe state (`queued|running|passed|failed|timed_out`) and completion time,
not the agent's surrounding transcript. A matching reply marks the probe
passed; any other response is `failed` without returning its text.

Smoke tests are owner-enabled per enrolled agent and disabled by default for
existing specialists. Once enabled, they are rate-limited to one per agent per
15 minutes and three per hour. This makes model cost and unsolicited work an
explicit owner decision while still allowing routine debugging.

## Operator-only CLI

The host CLI mirrors observability without making it container-accessible:

```sh
ncl groups factory status --id <agent-group-id>
ncl groups factory wake --id <agent-group-id> --reason "..."
ncl groups factory smoke enable --id <agent-group-id>
ncl groups factory smoke disable --id <agent-group-id>
```

All are `hostOnly`. `status` is read-only; smoke-policy changes are
root-grant issuer operations. `wake` is immediate and idempotent under the
same factory-relation check as the MCP call. These commands never expose
secrets or raw logs and do not grant broad cross-group `ncl` access.

## Data and audit

Add host-owned records:

```text
factory_runtime_observations(
  agent_group_id, observed_at, lifecycle, container_state,
  pending_work, last_failure_category, last_failure_at
)

factory_smoke_tests(
  correlation_id, agent_group_id, requested_at, status,
  completed_at, failure_category
)

factory_managed_agent_policy(
  agent_group_id, smoke_enabled, changed_at, changed_by_owner_id
)
```

Runtime observations may retain only normalized categories and timestamps.
They must never store raw prompt/response text, credentials, path values, or
provider error bodies. Smoke requests, policy changes, denials, and smoke
completion are appended to `factory_audit_events` (or a linked append-only
runtime audit table). Status reads and idempotent wakes are not audited.

## Failure handling

- A failed status lookup returns a structured `unknown` state, never a raw
  host exception.
- Provider authentication or transport failures become normalized categories.
- Expired authentication, unavailable Docker, or missing active sessions are
  reported as operator attention; the factory must not attempt credential
  refreshes, Docker starts, config changes, or mount changes.
- Rejected/expired approval and rate-limit decisions make no state change.

## Acceptance criteria

- A factory principal can distinguish each managed specialist's `running`, `idle`,
  `no_active_session`, and normalized `error` state without cross-group CLI.
- A factory principal cannot query an unrelated group or retrieve raw
  logs/configuration.
- A wake works only for an enrolled active session, is immediate/idempotent,
  and never kills a running container or sends arbitrary model input.
- A smoke test is unavailable until the owner enables it, uses only the fixed
  probe, reports a correlation ID, and stores no transcript content.
- A provider authentication failure appears as `provider_auth`, enabling an
  operator to refresh credentials without giving Copilot credential access.
- A factory principal can complete: inspect status → send permitted work or
  request wake → inspect outcome → revise managed instructions → verify.
- No operation broadens the principal's effective capability set or CLI scope.

## Rollout and definition of done

1. Implement host and container tools plus unit tests for ownership,
   redaction, rate limits, and no-active-session behavior.
2. Deploy to a test managed agent with smoke disabled, then enable it through
   the operator CLI.
3. Run the loop from both Copilot and a non-Copilot delegated parent.
4. Verify a deliberately expired provider credential is normalized as
   `provider_auth` and requires only the dedicated operator reauth flow.
5. Do not call the slice complete until a delegated parent can diagnose an
   inactive and an auth-failing child without broader access.

# Spec: local-model connectivity

## Goal

Make local OpenAI-compatible templates reliably testable from NanoClaw
containers, without exposing arbitrary network access.

## Host-owned endpoint contract

The host configures one fixed endpoint per runtime profile: the LM Studio host
endpoint is `http://127.0.0.1:1234/v1`. A narrow host-owned bridge is the only
container-visible endpoint, at `http://local-model.bridge:1234/v1`. Containers
receive no arbitrary base-URL field. The bridge permits only `/models` and
bounded `/chat/completions` for the checked-in model allowlist; it has no
credentials, mounts, or configurable upstream.

A host health probe validates reachability, `/models`, and one bounded
completion. A second bounded probe runs from an ephemeral container on the
same internal network and reaches only `local-model.bridge`; both must succeed
before a local-model child becomes ready. Local-model children run
on an internal network and cannot directly reach the host or another endpoint.

The host stores only endpoint profile ID, reachable boolean, approved-model
availability, checked timestamp, and a failure category—never raw traffic or
credentials.

## Runtime behavior

- Provisioning fails closed if the model is unavailable or unhealthy.
- Existing local children expose `backend_unhealthy` with a redacted health
  category when the host probe fails; status and smoke-test APIs expose the
  failure without exposing endpoint details.
- Only the host changes endpoint profile, model installation, or network
  routing. Agents may request but cannot apply a change.

## Goal-mode implementation boundary

Implement the probe on the host and use the fixed bridge as the only
container-side route. The host probe proves endpoint health; bridge startup and
the internal container network prove the runtime route. Both must pass before a
local template becomes ready. Use a fixed endpoint-profile allowlist and a
fixed short health-test request. Do not expose the host URL, arbitrary headers,
model downloads, or network tooling to agents.

The initial implementation targets the existing LM Studio endpoint at
`http://127.0.0.1:1234/v1`; failure reports only a redacted endpoint,
inventory, or completion category.

## Required verification

- Healthy and unavailable endpoint cases, missing model, invalid response, and
  container-only connectivity failure.
- Provisioning fails closed and leaves no active local child when health fails.
- A healthy local template runs its fixed smoke fixture successfully.

## Acceptance criteria

- “Unable to connect” becomes a deterministic endpoint-health failure.
- A container cannot redirect inference to a different host or port.
- A passing health check precedes every local-template smoke test.

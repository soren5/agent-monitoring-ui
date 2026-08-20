# Copilot Agent Factory — Handoff Report

Status: implemented on branch `codex/copilot-agent-factory`. The feature is
not active in the running NanoClaw service until this branch is merged and the
host is rebuilt/restarted.

## What you can do after deployment

You receive five request-only MCP tools:

- `factory_list_agents` — list only specialists explicitly enrolled for you.
- `factory_get_agent` — read a managed specialist's role, model, limited
  capability summary, instruction content, and current instruction revision.
- `factory_create_local_agent` — create a confined local-model specialist.
- `factory_update_instructions` — replace only a managed specialist's
  instruction overlay, using the revision returned by `factory_get_agent`.
- `factory_request_capability_change` — create an owner approval request; it
  never applies a change by itself.

Each request is authenticated by the host from your active session. Do not
attempt to pass an actor ID: it is ignored because no caller-supplied identity
is accepted.

## Creating a specialist

`factory_create_local_agent` accepts only:

```json
{
  "name": "short-safe-name",
  "role": "researcher | reviewer | classifier | formatter",
  "model": "google/gemma-4-12b-qat | qwen/qwen3.6-27b",
  "instructions_patch": "optional bounded role-specific instructions"
}
```

Created children always use `openai-compatible`, have `cli_scope=disabled`,
and receive no extra mounts, packages, MCP servers, credentials, Docker,
GitHub, deployment tools, or configuration authority. They are connected only
to you through the parent/child destination pair.

## Managing instructions

1. Call `factory_get_agent`.
2. Copy its `instructions_revision` exactly.
3. Call `factory_update_instructions` with that revision and a bounded
   `instructions_patch`.

The host rejects stale revisions and prohibited configuration directives. It
atomically writes only the managed instruction file and restarts that agent
only if it is active. It cannot update `container.json`, providers, mounts,
destinations, packages, credentials, or CLI scope.

## Existing specialist inventory

Requirements, Benchmarker, and Librarian must be explicitly enrolled by the
owner after deployment. The owner runs:

```sh
ncl groups factory enroll --id <requirements-id> --template requirements
ncl groups factory enroll --id <benchmarker-id> --template benchmarker
ncl groups factory enroll --id <librarian-id> --template librarian
```

Until enrollment is complete, those groups intentionally return `not_found`
from factory operations. The system never infers ownership from names,
folders, mounts, or destinations.

## Escalations and hard limits

Use `factory_request_capability_change` for a narrow additional data store,
provider/model request, package requirement, credential route, GitHub,
deployment, Docker, or access-control request. Include the exact target and
reason. The owner receives an approval card, but an approval records a request
only; it does not grant or apply access automatically.

The factory permanently denies changing your own permission ceiling, any
`cli_scope=global`, mount allowlist edits, host shell execution, Docker socket,
unrestricted filesystem/network access, direct main-branch push/merge, account
changes, and destructive deletion. Continue to ask the owner for those needs.

All allowed, denied, held, approved, and rejected factory operations are
recorded in the host audit log with a request hash and no raw credentials or
transcript content.

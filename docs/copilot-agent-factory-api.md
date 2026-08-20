# Copilot Agent Factory Host API

## Purpose

Provide Copilot with a narrow, host-enforced control surface for managing its
specialist agents without granting `cli_scope: global`, raw cross-group `ncl`,
host mounts, credentials, deployment controls, or access-control authority.

The API is an internal NanoClaw delivery action / MCP-backed host capability,
not an HTTP service exposed to containers. Copilot may invoke it only through
its existing authenticated agent session. The host derives the caller identity
from that session; no request may supply or override an actor id.

## Trust model

- **Factory principal:** only Copilot group
  `ag-2368054c-2186-47cd-9ebe-4d4868176377`.
- **Managed agents:** only agents whose `factory_parent_group_id` is Copilot,
  recorded on creation. Existing specialists may be enrolled explicitly by the
  owner; no name-, folder-, or destination-based inference is allowed.
- **Default child:** a fresh local-model group with `cli_scope: disabled`, no
  additional mounts, no MCP servers, no installed packages, no credentials,
  and no deployment/GitHub/Docker authority.
- **Host boundary:** mount changes remain `hostOnly` operations and can never
  be requested through this API, including by approval replay.

## Operations

### `factory.list_agents`

Returns a read-only inventory of enrolled agents.

Response fields:

```json
{
  "agents": [
    {
      "agent_group_id": "ag-...",
      "name": "benchmarker",
      "role": "benchmarker",
      "provider": "openai-compatible",
      "model": "google/gemma-4-12b-qat",
      "cli_scope": "disabled",
      "status": "active|idle|unknown",
      "instructions_revision": "sha256:...",
      "factory_parent_group_id": "ag-2368054c-2186-47cd-9ebe-4d4868176377"
    }
  ]
}
```

It must not return credentials, raw mount paths, OneCLI values, private
conversation transcripts, approval data, or unrelated group configuration.

### `factory.get_agent`

Returns the enrolled agent's role, approved template, effective provider/model,
CLI scope, immutable capability summary, instruction content, and instruction
revision. It must return `not_found` for unenrolled or unrelated groups.

### `factory.create_local_agent`

Creates a fresh Copilot child without owner approval only when every field
matches the approved template policy:

- provider: `openai-compatible`
- model: an owner-maintained allowlist, initially
  `google/gemma-4-12b-qat` and `qwen/qwen3.6-27b`
- role: an approved template identifier
- `cli_scope: disabled`
- no additional mounts, packages, MCP servers, credentials, or external
  destinations beyond the bidirectional parent/child destination

Input:

```json
{
  "name": "short-safe-name",
  "role": "researcher|reviewer|classifier|formatter",
  "model": "google/gemma-4-12b-qat",
  "instructions_patch": "optional bounded role-specific additions"
}
```

The host creates the group, writes a factory ownership record, materializes the
template, records an audit event, and returns the new group id. The host rejects
unrecognized roles, oversized instructions, duplicate names, and any request
containing provider, mount, package, credential, or permission fields.

### `factory.update_instructions`

Updates only the enrolled agent's managed instruction overlay. It never writes
`container.json`, provider state, group membership, destinations, mounts, or
arbitrary group files.

Input:

```json
{
  "agent_group_id": "ag-...",
  "expected_revision": "sha256:...",
  "instructions_patch": "bounded markdown patch"
}
```

The host applies the patch atomically, validates size and prohibited directives,
increments the revision, writes an audit event, and restarts only that agent if
it is active. Optimistic revision matching prevents lost updates.

### `factory.request_capability_change`

Creates an owner-facing approval request; it never applies a change itself.

Supported request categories:

- additional read-only source/archive data
- narrow writable result store
- provider/model change
- package requirement
- hosted credential route
- GitHub, deployment, Docker, or access-control request

Each request must contain exact target group, reason, requested path/tool,
read/write mode, expiry if applicable, and a risk summary. Approval cards must
identify this as a Copilot factory escalation. Rejection leaves state unchanged.

## Immutable denials

The API must reject these requests before creating an approval hold:

- changing Copilot's own `cli_scope` or permission ceiling;
- granting any agent `cli_scope: global`;
- adding or altering host mount allowlist roots;
- raw shell command execution on the host;
- Docker socket, unrestricted host filesystem, or arbitrary network proxy;
- direct push/merge to `main`, account changes, or deletion of material data.

## Data model and audit

Add a host-owned `factory_managed_agents` table:

```text
agent_group_id PRIMARY KEY
factory_parent_group_id NOT NULL
template_id NOT NULL
instruction_revision NOT NULL
enrolled_at NOT NULL
enrolled_by_owner_id NULL
```

Add append-only `factory_audit_events` records with timestamp, caller group,
target group, operation, outcome, immutable request hash, resulting revision,
and approval id when applicable. Do not store raw credentials or unredacted
prompt/transcript content.

## API transport and lifecycle

1. Container MCP tool validates its small input schema and writes a system
   request.
2. Host delivery action authenticates the source session and calls the factory
   guard.
3. The guard verifies Copilot identity and managed-agent ownership.
4. Host performs an allowed action, creates an approval, or rejects it.
5. The result is delivered back to Copilot as a structured system message.

No container-side prompt or tool implementation is an authorization boundary.

## Acceptance tests

- Copilot can list enrolled Requirements, Benchmarker, and Librarian agents.
- Copilot can create an approved local child; the child has disabled CLI scope,
  no mounts, no packages, no MCP servers, and no credentials.
- Copilot can update only an enrolled agent's instruction overlay with matching
  revision; stale revisions fail without modifying files.
- Copilot cannot read or update an unrelated group.
- Copilot cannot modify `container.json`, mounts, provider credentials,
  destinations, packages, or CLI scope through any factory operation.
- A capability-change request creates an owner approval card and produces no
  state change until approval.
- Rejected/expired approval grants cannot be replayed.
- Every success, rejection, and approval outcome has an audit event.

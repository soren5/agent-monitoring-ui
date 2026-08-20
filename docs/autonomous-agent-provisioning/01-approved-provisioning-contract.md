# Spec: approved agent provisioning contract

## Goal

Replace ad-hoc creation, enrollment, grants, and session setup with one
owner-approved, immutable provisioning contract. A request creates no agent
until the owner approves it.

## Request and approval

An authenticated parent submits `factory_request_agent_provision`:

```json
{
  "template_id": "requirements-parent",
  "display_name": "Requirements",
  "repository_id": "optional approved repository",
  "project_bootstrap": {
    "project_id": "agent-monitoring-ui",
    "platform_id": "discord:<guild-id>:<channel-id>"
  }
}
```

The host derives the parent from the session and validates template, name,
ancestry, channel canonicality, repository relation, and attenuation before
creating a pending row. The approval card shows the exact derived child profile.

Approval atomically creates the child and all contract records. Rejection or
expiry creates nothing. The contract is immutable; a change is a new request.

`project_bootstrap` is restricted to the `requirements-parent` template and a
root parent. It is mandatory for that template. One approval creates the
Requirements agent, its project record, the parent-first shared Discord
messaging group, repository profile (when requested), and its private session.
No subsequent `project create` or root-capability command is needed. Other
templates use `project_id` only to join an already-live project.

## Persistence

```text
agent_provision_requests(
  request_id PRIMARY KEY, parent_agent_group_id, project_id, project_bootstrap_id, template_id,
  display_name, capability_profile_id, repository_id, channel_type, platform_id,
  state[pending|approved|rejected|provisioned|failed], owner_approval_id,
  created_at, resolved_at, provisioned_child_group_id
)
agent_provision_audit_events(...request_id, outcome, request_hash, created_at)
```

The unique active key is `(parent_agent_group_id, normalized_display_name)`.

## Goal-mode implementation boundary

Implement this only after the generic relation and template registry slices.
Reuse the existing approvals primitive; do not create a second owner-response
format. Add one request-only MCP tool and one host delivery action. The action
may create a pending approval, but only the approval-resolution handler may
materialize a child. Store the canonical, host-derived request fields and a
template revision snapshot in the pending row.

No caller may submit a raw capability grant, mount, provider URL, package,
credential, Discord token, session ID, or actor ID. A pending request is not a
capability and cannot be used to dispatch, wire, or inspect a future child.

## Required verification

- Pending, approved, rejected, expired, duplicate, and replayed requests.
- Owner approval is atomic: inject failures at every materialization step and
  assert no child/group/grant/destination remains.
- A child request broadened beyond parent/template/project authority is denied
  before an owner card is created.

## Acceptance criteria

- A parent cannot create an agent without an owner-approved request.
- One approval produces a runnable child with no additional operator commands.
- Duplicate, stale, cross-project, or broadened requests are denied.
- Replaying approval is idempotent and returns the original child.

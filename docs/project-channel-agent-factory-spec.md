# Project-Channel Agent Factory

## Objective

Support two deterministic communication topologies without granting broad
configuration, host, credential, or cross-project access:

- **Singletons:** Copilot, Benchmarker, and Librarian each own one independent
  Discord channel and retain the existing single-responder wiring model.
- **Projects:** a shared Discord project channel has one high-authority parent
  (initially a Requirements agent). That parent may create, dispatch, and
  manage narrowly authorized descendants for that project only.

“Freely” means unattended within an already-issued host capability ceiling. It
never means a prompt-created exemption, global CLI scope, arbitrary Discord
wiring, or self-escalation.

## Project record

The host owns a project record; agent names, folders, channel text, and model
instructions do not establish project membership.

```text
projects(
  project_id PRIMARY KEY,
  project_parent_group_id NOT NULL REFERENCES agent_groups(id),
  channel_type NOT NULL,                 -- initially discord only
  platform_id NOT NULL,                  -- canonical discord:<guild>:<channel>
  messaging_group_id NOT NULL REFERENCES messaging_groups(id),
  created_at NOT NULL,
  closed_at NULL,
  UNIQUE(channel_type, platform_id) WHERE closed_at IS NULL
)

project_agents(
  project_id NOT NULL REFERENCES projects(project_id),
  agent_group_id NOT NULL REFERENCES agent_groups(id),
  parent_agent_group_id NOT NULL REFERENCES agent_groups(id),
  role_id NOT NULL,
  created_at NOT NULL,
  removed_at NULL,
  PRIMARY KEY(project_id, agent_group_id)
)
```

One active project owns one shared channel. A singleton channel cannot also be
a project channel. A project parent is the root of the project membership tree;
every later agent has immutable parent provenance.

## Capability model

The owner issues a bounded root grant to the project parent:

```text
resource_type: project
resource_id: <project-id>
actions:
  create-child
  dispatch-child
  wire-descendant
  remove-descendant
  list-agents
  get-status
  report-project-channel
constraints:
  channel_type: discord
  platform_id: discord:<guild>:<project-channel>
  allowed_roles: [junior, api, local-coding, test, reviewer]
  allowed_models: [...owner allowlist...]
  child_permission_ceiling: <explicit capability subset>
```

The host validates every requested child capability through normal attenuation:

```text
child grant = requested grant ∩ parent effective grants ∩ project ceiling
```

The parent may delegate any listed management action only to a newly-created
descendant, with a narrower role/model/capability set. A delegated child can
then create and manage only its own transitive descendants; it cannot manage a
sibling or ancestor. A project agent cannot manage singleton agents,
agents in a different project, its parent, or an arbitrary pre-existing group.
Revoking the project root grant invalidates all derived grants and rejects the
next management call before state mutation.

## Routing model

The project channel is intentionally not a general multi-agent broadcast.
Ordinary channel messages route to the project parent only. This makes the
parent the deterministic intake and avoids duplicate replies.

Each project child receives a channel **report destination**. It may send a
bounded report to the project channel, but it does not receive ordinary user
traffic from that channel.

Direct user interaction with a child is optional and must use a deterministic
addressing rule, initially an exact agent alias/mention:

```text
@api <request>       -> API child only
@junior <request>    -> Junior child only
unaddressed message  -> Requirements parent only
```

The host resolves aliases from project-owned records, never from agent-provided
text. An alias maps to at most one active project agent. Mention-sticky state
is scoped to `(project, thread, addressed agent)`; it must not cause an
unaddressed message to fan out to every child.

All project members may reply only to the same project channel through their
project-owned destination. No operation creates a second inbound responder for
ordinary traffic, a cross-project route, a DM route, or a raw Discord token.

## Factory operations

These are authenticated session-to-host actions/MCP tools. The host derives
the caller; payloads never set an actor or grant.

### `project_create_child`

Input:

```json
{
  "project_id": "project-...",
  "name": "api",
  "role": "api",
  "model": "google/gemma-4-12b-qat",
  "requested_actions": ["create-child", "dispatch-child"]
}
```

Creates a new descendant only when the caller has `project/create-child`,
`project/report-project-channel`, and every requested action. All inputs meet
the host role/model ceiling. The host records membership, creates the child’s
constrained configuration, materializes only the requested attenuated project
actions plus its report capability, and creates a report destination to the
project channel.

### `project_dispatch_child`

Input:

```json
{ "project_id": "project-...", "agent_group_id": "ag-...", "task": "bounded work" }
```

Requires `project/dispatch-child` plus a caller-to-descendant relation. It injects
work only into an existing project descendant session. Messages do not convey
capabilities.

### `project_wire_descendant`

Input:

```json
{ "project_id": "project-...", "agent_group_id": "ag-..." }
```

Requires `project/wire-descendant`. It is idempotent and creates only the
project-channel report destination. It cannot accept a caller-supplied channel
or routing-policy field: both are derived from the project record.

### `project_list_agents` and `project_get_status`

Return only project-owned, host-derived metadata: role, model, bounded
capability summary, alias, lifecycle category, and channel routing status.
Never return credentials, raw container/session IDs, mounts, transcripts, raw
logs, or unrelated agent configuration.

### `project_remove_descendant`

Removes only one exact project membership and its project-owned report/direct
alias routes. It revokes child-derived capabilities transitively. It must not
delete the shared project channel, unrelated agent destinations, or singleton
wiring.

## Owner activation

Project creation is part of an approved `requirements-parent` provisioning
request, not a follow-up operator sequence. The request includes only the
project identifier and canonical Discord channel ID:

```json
{
  "template_id": "requirements-parent",
  "display_name": "Requirements",
  "project_bootstrap": {
    "project_id": "agent-monitoring-ui",
    "platform_id": "discord:<guild-id>:<project-channel-id>"
  }
}
```

On approval the host atomically creates the project, gives Requirements the
sole ordinary-message route, records the hierarchy, and derives only the
template-bounded child-management authority. The legacy owner-only CLI remains
for existing projects but is not part of new-project activation.

## Deterministic denials

The host denies before execution:

- bare Discord IDs, DMs, cross-guild channels, or any caller-supplied channel
  in a child-wiring request;
- creating or managing an agent outside the caller’s project descendant tree;
- adding a child permission, mount, credential route, provider/model, package,
  repository scope, branch prefix, or network route not covered by the parent;
- modifying singleton channel routes through the project API;
- arbitrary project-channel fan-out or duplicate ordinary-message responders;
- raw host shell, Docker, global/cross-group `ncl`, raw credential access, and
  direct modification of capability/project records by containers.

## Migration from the singleton Factory API

Keep `factory_*channel*` operations for singleton agents. Do not weaken their
one-responder invariant.

Add project operations beside them. Generalize shared factory helpers only
where the authenticated caller’s project relation and effective grant are
checked; do not replace those checks with a generic `isCopilot` bypass.

Requirements and Junior become project-role templates. Copilot may create a
project only if an owner-issued root grant permits it; Copilot is not a special
authorization case once the project exists.

## Acceptance criteria

- An owner creates one project channel with Requirements as its parent; the
  parent can create and dispatch a Junior/API child with only attenuated
  project capabilities.
- The child can report to the shared channel but cannot receive or answer an
  unaddressed project message; Requirements receives that message exactly once.
- An exact `@alias` routes only to the matching active project child.
- A project parent cannot create/wire a child outside its project channel,
  alter a singleton, or grant a broader role/model/repository/mount/provider
  capability than it holds.
- Removing/revoking a project child removes only its project-owned routes and
  invalidates its derived capabilities; other project members and singleton
  channels still function.
- All project creation, child lifecycle changes, grants, wire/unwire decisions,
  dispatches, and denials are append-only audited without secrets or message
  content.

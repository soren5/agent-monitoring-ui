# Factory-Managed Agent Discord Wiring

## Objective

Allow an authorized parent agent to give an enrolled descendant exactly one
safe Discord work channel, without global CLI access, raw Discord credentials,
cross-group configuration access, or an ability to wire unrelated agents.

This is a deterministic host capability. A prompt, factory enrollment, or
Discord channel ID alone never authorizes a wiring change.

## Authorization model

The host authenticates the caller from its session and requires an effective
capability grant:

```text
resource_type: channel
resource_id: discord:<guild-id>:<channel-id>
action: wire-descendant
constraints: { descendant_agent_group_id: "ag-..." }
```

The target must be an enrolled descendant of the caller's factory relation.
Legacy children, including Junior, are eligible only after an explicit owner
grant establishes the same relation; agent names and directory structure are
never evidence of authority. Delegated grants must attenuate normally, so a
child cannot receive a channel, agent, or action the parent does not hold.

The host rejects DMs, bare channel IDs, a different Discord guild, unknown
channel types, expired/revoked grants, unrelated agents, and attempts to
replace another agent's channel wiring. No raw `ncl` or config mutation is
made available to containers.

## Factory MCP operations

### `factory_wire_agent_channel`

Input:

```json
{
  "agent_group_id": "ag-...",
  "channel_type": "discord",
  "platform_id": "discord:<guild-id>:<channel-id>"
}
```

The server, not the caller, fixes the initial policy:

```json
{
  "engage_mode": "mention-sticky",
  "sender_scope": "strict",
  "session_mode": "per-thread"
}
```

It must:

1. authenticate the source session and resolve its live effective grants;
2. verify exact descendant and channel authority;
3. validate that the canonical Discord platform ID belongs to the approved
   guild and represents a server channel, not a DM;
4. create or reuse one host-owned messaging group for the exact channel;
5. ensure the group has exactly the target agent as its responding member;
6. create/reuse the target agent's reply destination and project it to active
   sessions; and
7. write an append-only audit event and return the concrete safe wiring state.

The call is idempotent on `(agent_group_id, channel_type, platform_id)`. A
second call for the same tuple returns the existing wiring. A request that
would make two agents respond in one channel is denied; replacement requires
an explicit `factory_unwire_agent_channel` followed by a new grant-backed
wire.

### `factory_list_channel_wirings`

Optional input:

```json
{ "agent_group_id": "ag-..." }
```

Returns only descendants the caller is allowed to manage, with agent ID/name,
canonical channel ID, wiring ID, and host-selected policy. It never returns
other groups' arbitrary configuration, credentials, raw logs, session IDs,
or transcripts.

### `factory_unwire_agent_channel`

Input:

```json
{
  "agent_group_id": "ag-...",
  "channel_type": "discord",
  "platform_id": "discord:<guild-id>:<channel-id>"
}
```

Requires the same live exact capability as wiring. It removes only the exact
factory-created agent/channel mapping. The host deletes a messaging group only
when it is empty and owned by this factory wiring; unrelated routes and
destinations remain untouched. The call is idempotent and audited.

## Deterministic data model

Add a host-owned `factory_channel_wirings` record:

```text
wiring_id PRIMARY KEY
factory_parent_group_id NOT NULL
agent_group_id NOT NULL
channel_type NOT NULL
platform_id NOT NULL
messaging_group_id NULL after factory-owned group deletion
created_messaging_group NOT NULL
policy_json NOT NULL
created_at NOT NULL
revoked_at NULL
UNIQUE(agent_group_id, channel_type, platform_id) WHERE revoked_at IS NULL
UNIQUE(channel_type, platform_id) WHERE revoked_at IS NULL
```

The second uniqueness rule enforces one responding agent per Discord channel.
The host derives all IDs and does not trust IDs returned by a container beyond
schema validation.

Record each success, denial, idempotent result, and unwire in
`factory_audit_events` with actor group, target group, action, capability grant
chain IDs, canonical resource, outcome, request hash, and timestamp. Never
record raw Discord content or credentials.

## Initial owner-issued grants

The owner may issue these four exact grants to Copilot, after canonicalizing
each ID with the Discord server ID:

```text
Requirements  ag-1785573749465-3ls7uo -> 1533032647809306735
Benchmarker   ag-1785573758263-r9ym6l -> 1533671865481171045
Librarian     ag-1785573765753-n0c33l -> 1533671879490015393
Junior        ag-1785554727134-nt43ak -> 1533671965087236187
```

These are four independent grants, not a generic `channel/wire` grant.
Changing a channel requires a new owner-issued root grant. The platform IDs
stored in the grants must use the canonical server-qualified form.

Requirements, Benchmarker, and Librarian are already factory-enrolled. Before
wiring Junior, enroll it through the existing owner-only factory command with
the explicit `junior` template; enrollment grants no channel capability.

After deployment, issue each grant from the host with the generic owner-only
capability command (substitute the server ID in every resource ID):

```sh
ncl groups capability grant-root --id ag-2368054c-2186-47cd-9ebe-4d4868176377 \
  --resource-type channel --resource-id discord:1529768980787757106:<channel-id> \
  --action wire-descendant --descendant-agent-group-id <agent-group-id>
```

## Acceptance criteria

- Copilot can wire each of the four explicitly granted descendants to only its
  exact approved Discord channel.
- The same call is idempotent and a channel cannot acquire a second responder.
- Copilot cannot wire an unrelated group, a DM, another server, or an
  ungranted channel.
- Copilot receives no Discord token, raw cross-group CLI access, or arbitrary
  configuration-write capability.
- Removing one exact wiring leaves all other channel and agent routes intact.
- Revoking the relevant root grant denies future wire/unwire calls before any
  routing mutation.
- Unit and integration tests cover grant attenuation, canonicalization,
  duplicate-responder denial, idempotency, audit records, and live destination
  projection.

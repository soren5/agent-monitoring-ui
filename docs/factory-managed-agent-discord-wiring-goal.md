# Goal-mode prompt: deterministic managed-agent Discord wiring

Implement `docs/factory-managed-agent-discord-wiring-spec.md` in NanoClaw.

Work autonomously through implementation, tests, documentation updates, and a
review-ready commit. Stop only for a genuine design ambiguity or owner action
that cannot be safely inferred. Do not broaden the task into global CLI,
general Discord administration, raw token access, or arbitrary configuration
editing.

Required outcome:

1. Add host-enforced Factory MCP operations:
   `factory_wire_agent_channel`, `factory_list_channel_wirings`, and
   `factory_unwire_agent_channel`.
2. Authorize each mutation through the caller's live, attenuated
   `channel/wire-descendant` grant for the exact enrolled descendant and
   canonical Discord server/channel resource.
3. Enforce one responding agent per Discord channel and fixed host-selected
   `mention-sticky`, `strict`, `per-thread` policy. Do not expose policy fields
   as caller-controlled options in this slice.
4. Create the host-owned wiring record and append audit events without storing
   Discord content, tokens, session IDs, or raw configuration.
5. Project successful wiring changes to active sessions safely and
   idempotently.
6. Support only the four owner-granted trial routes defined in the spec after
   their IDs are canonicalized. Do not hard-code agent-name exceptions;
   validate descendant relation and capability grants.
7. Add focused tests for authorization/attenuation, canonical-ID validation,
   duplicate responder denial, idempotency, unwire isolation, revocation, and
   live-session projection.

Non-negotiable security properties:

- Host derives caller identity from the session; request payloads never choose
  actor identity.
- Bare Discord IDs, DMs, cross-server channels, unrelated agents, expired or
  revoked grants, and second-responder attempts are denied before state change.
- Containers receive neither Discord credentials nor global/cross-group `ncl`
  authority.
- `factory_unwire_agent_channel` only changes its exact factory-owned wiring.

Before marking complete, run relevant unit tests and the project build, inspect
the resulting diff for accidental permission broadening, and report the exact
owner command/action still needed to issue the four root grants.

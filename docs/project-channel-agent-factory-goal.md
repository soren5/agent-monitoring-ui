# Goal-mode prompt: project-channel agent factory

Implement `docs/project-channel-agent-factory-spec.md` in NanoClaw.

Work autonomously through implementation, focused tests, documentation updates,
and a review-ready commit. Stop only for a genuine design ambiguity or an owner
authorization that cannot be safely inferred. Do not replace the existing
singleton factory wiring model with a broad multi-agent broadcast model.

Required outcome:

1. Add host-owned project and project-agent records, binding one active project
   parent to one canonical Discord server channel.
2. Add authenticated, host-enforced project operations for child creation,
   dispatch, project-channel report wiring, listing/status, and exact child
   removal.
3. Generalize factory authorization from a Copilot-specific check only where
   the authenticated caller has a live project relation and effective project
   capability. Preserve the existing singleton `factory_*channel*` behavior.
4. Enforce capability attenuation for every project child. A child receives
   only the requested intersection of its parent’s grants and the project
   ceiling.
5. Route unaddressed project-channel messages to Requirements exactly once.
   Children receive only explicit exact alias mentions; they may report to the
   shared project channel through host-owned destinations.
6. Do not accept caller-supplied project channel, routing policy, actor,
   capability grant, mount, credential, package, Docker, host-shell, global
   CLI, or arbitrary configuration fields.
7. Keep singleton channels isolated: project operations must not create a
   second ordinary-message responder in a singleton channel or mutate its
   wiring.
8. Add migration, request-only MCP tools, live-session destination projection,
   append-only redacted auditing, and documentation for the owner setup path.

Non-negotiable security properties:

- The host derives caller identity from the authenticated session.
- A project parent can manage only descendants in its own active project and
  only while its exact project grant is live.
- Canonical Discord IDs are required; DMs, bare IDs, cross-project channels,
  cross-guild routes, and arbitrary fan-out are denied before mutation.
- Mention aliases are host-owned and unique within a project. Sticky routing is
  scoped to the addressed agent and thread; it cannot make later unaddressed
  messages fan out.
- Removing/revoking a child invalidates its derived grants and removes only its
  project-owned routes. It must not affect sibling agents, the parent, shared
  project history, or singleton channels.
- Containers never receive Discord tokens, host credentials, global/cross-group
  `ncl`, raw sessions/container IDs, or direct database access.

Required verification:

- Project creation and Requirements parent enrollment.
- Attenuated child creation and out-of-scope permission denial.
- Exactly-once unaddressed routing to the parent.
- Exact alias routing to one child only, including thread-sticky isolation.
- Child report delivery to the project channel.
- Singleton-wiring isolation and duplicate-responder denial.
- Revocation/removal cleanup and audit records.
- Relevant unit/integration tests and the project build.

Before marking complete, inspect the diff for permission broadening, report the
exact owner-side root-grant/project-creation commands needed for activation,
and leave the implementation committed and ready for review.

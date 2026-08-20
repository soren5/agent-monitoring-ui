# Spec: channel binding approval

## Goal

Make optional Discord wiring a field of the owner’s one-time provisioning
approval, removing separate enrollment and per-channel root-grant steps.

## Input and validation

The owner supplies a canonical server channel ID:

```text
discord:<guild-id>:<channel-id>
```

Bare IDs, DMs, unknown instances, alternate guilds, and caller-supplied routing
policies are rejected. The host verifies the channel is not already a singleton
responder or an incompatible active project channel.

## Binding modes

- `singleton`: approved child is sole responder; host fixes mention-sticky,
  strict sender scope, and per-thread policy.
- `project-report`: child can report only; project parent remains the sole
  ordinary inbound responder.
- `project-alias`: child receives only exact host-owned alias traffic.

Template and project relation determine eligible modes. A parent cannot turn a
report route into a responder route.

## Goal-mode implementation boundary

Channel binding is optional contract data and is resolved only during owner
approval. Retain canonical IDs; do not add raw-ID canonicalization. The host
may create a `messaging_groups` row and fixed wiring, but agents cannot select
an instance, engage mode, sender scope, session mode, alias, or destination
name.

If the owner creates a Discord channel manually, they provide its canonical ID
in the approval. This slice does not grant the bot Discord channel-management
permission or create channels through Discord's API.

## Required verification

- Singleton, project-report, and project-alias bindings each use only their
  fixed host-selected routing behavior.
- Existing singleton and project-channel conflicts deny without mutation.
- Removal/revocation cleans only contract-created wiring and destinations.

## Acceptance criteria

- Approval creates wiring, destination, and live-session projection.
- Replaying approval is idempotent.
- A second ordinary responder is denied before state mutation.
- Unwire/removal affects only this exact host-owned binding.

# Spec: declarative agent templates

## Goal

Let agents choose approved roles without granting arbitrary container
configuration.

## Template registry

Host-owned templates define:

```text
template_id, provider, allowed_models, instruction_base, tool_profile,
repository_profile, channel_profile, capability_ceiling,
max_descendant_depth, smoke_test_id
```

Initial templates: `requirements-parent`, `api`, `junior`, `local-coding`,
`local-test`, `reviewer`, `researcher`, `classifier`, and `formatter`.

The registry is versioned. A request names a template and an optional bounded
instruction overlay; it cannot set raw provider URLs, image tags, mounts,
packages, MCP servers, environment variables, or credentials.

## Resolution

The host selects provider/model from the template and owner-approved allowlist.
Codex and local OpenAI-compatible runtimes are eligible only if their health
gate passes. The overlay is size-limited and rejected if it attempts to change
permissions, routing, credentials, packages, mounts, or host configuration.

## Goal-mode implementation boundary

Persist templates in a host-owned, versioned registry or checked-in manifest
loaded only at host startup. The container receives a resolved template ID and
safe instruction text, never the registry write surface. A template profile
must name every available tool and mount class explicitly; omitted means denied.

Changing a template affects only future provisioning by default. Existing
children retain their resolved version until an owner-approved reprovision or
explicit host migration; no silent capability drift is permitted.

## Required verification

- Unknown template, unsupported model, malformed overlay, and profile broaden
attempts are denied before approval.
- Resolved configuration matches the selected template exactly.
- Existing child behavior is unchanged after an unrelated template revision.

## Acceptance criteria

- Every child has a named, versioned profile explainable to the owner.
- Changing role/provider needs a new approved provisioning request.
- A template cannot exceed its parent/project capability ceiling.

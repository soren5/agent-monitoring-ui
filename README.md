# Agent Monitoring UI

Single repository for the Agent Monitoring UI project.

## Layout

- **Repo root** — the NanoClaw runtime source this UI monitors (imported so
  M1-T01 capability inventory and M1-T03 runtime-integration work operate on the
  exact live code). Base: `6ef046ce` + auto-sync + repository-broker fixes.
- **`plugin/`** — the Obsidian desktop plugin that monitors NanoClaw agents
  (Milestone 1 UI scaffold).

## Branch conventions

Single M1 namespace on this repo:

- `feature/m1-agent-monitor-events` — NanoClaw runtime-side changes.
- `feature/m1-ui-scaffold` — Obsidian plugin scaffold under `plugin/`.

# DeepSeek Usage Reporting — Design

## Status

Draft — design only, no implementation yet. Landed after the native `deepseek`
provider (PR #11) so this doc describes a follow-up change on top of it.

## Problem

The existing usage-report system is **codex-specific and bespoke**:

- **Host bridge** (`src/usage-reader-bridge.ts`) spawns the local `codex` binary
  (`codex app-server --stdio`) and calls the codex `account/rateLimits/read`
  JSON-RPC to read ChatGPT subscription rate-limit state.
- **Provider contribution** (`src/providers/codex.ts`) injects
  `NANOCLAW_USAGE_READER_BRIDGE_URL` into codex containers only.
- **Container job** (`container/agent-runner/src/codex-usage-job.ts`) is gated
  at `startCodexUsageJob` on `providerName === 'codex'` (returns `null`
  otherwise), captures pre/post snapshots around each user-facing query, diffs
  numeric fields, and formats a `Codex usage` report to Discord
  (`formatUsageDelta` / `reportUsageDelta`).

After PR #11, agents switched to `deepseek` produce **no usage reports** —
`startCodexUsageJob` returns `null`, so the poll-loop silently skips them. The
semantics also don't transfer: the codex report measures *weekly ChatGPT
rate-limit percentage*, which does not exist for DeepSeek.

## Key difference: DeepSeek usage is in-band

DeepSeek is OpenAI-compatible. Every `POST /v1/chat/completions` response
includes a `usage` field:

```json
{
  "usage": { "prompt_tokens": 1234, "completion_tokens": 567, "total_tokens": 1801 }
}
```

The `deepseek` provider (from PR #11) already reads the response body
(`container/agent-runner/src/providers/deepseek.ts`) — it just discards
`usage` today. This means:

- **No host bridge.** No external reader binary, no JSON-RPC, no
  `NANOCLAW_USAGE_READER_BRIDGE_URL` env, no pre/post snapshot file diffing.
  The token counts come from the provider's own HTTP responses.
- **Direct, deterministic numbers.** `prompt_tokens` / `completion_tokens` /
  `total_tokens` are the provider's own billing-relevant counts, summed across
  the tool-call rounds of one user-facing turn.

This is strictly simpler than the codex path and should stay that way.

## Design

### 1. Provider emits a `usage` event

Add an optional member to the shared `ProviderEvent` union in
`container/agent-runner/src/providers/types.ts`:

```ts
export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  /** Internal audit split (thinking-mode output). Never shown in the report. */
  reasoningTokens?: number;
  totalTokens: number;
}

// in ProviderEvent:
| { type: 'usage'; usage: ProviderUsage }
```

The `deepseek` provider yields **one aggregated `usage` event per completed
turn** — summed across every chat-completions round in that turn (tool calls
included) — right before its `result` event. It keeps a running
per-query accumulator, like `history`, reset on each `query()`.

The report's single figure is `totalTokens`. Per DeepSeek's API schema,
`completion_tokens` already includes thinking-mode (`reasoning_tokens`) output,
and `total_tokens = prompt_tokens + completion_tokens`. Solving the problem took
`total_tokens`; whether part of it was reasoning or answering is irrelevant to
the operator. The prompt/completion/reasoning split is still captured (and
persisted for audit) so it can be analyzed later, but it never appears in the
Discord report.

Other providers simply never emit `usage`; the union member is optional and
the poll-loop handles absence. The exhaustive `switch (event.type)` in
`poll-loop.ts::handleEvent` gains a `case 'usage'` (log-only, like the other
events).

### 2. Poll-loop captures usage and reports per user-facing job

Mirror the codex job lifecycle, but without snapshots:

- `startDeepseekUsageJob({ providerName, routing, cwd })` — returns a job record
  only when `providerName === 'deepseek'` and the routing is a Discord
  channel (matching codex's `reportUsageDelta` guard), else `null`. It
  **does not** touch the host bridge.
- Inside `processQuery`, the event loop accumulates `usage` events into the
  active job (add `usage` to the job record, reset per job).
- `finishDeepseekUsageJob(job)` — when a job exists and carried usage:
  1. writes a `.nanoclaw/deepseek-usage/*.json` audit snapshot,
  2. updates the **shared usage store** (below),
  3. formats and routes a report to Discord via `writeMessageOut` (same
     mechanism as `reportUsageDelta`).

The `usageJobs` array in `poll-loop.ts` currently holds `CodexUsageJob | null`.
Extend it to hold a discriminated union
`{ provider: 'codex'; job: CodexUsageJob } | { provider: 'deepseek'; job: DeepseekUsageJob } | null`,
or run two parallel arrays — implementation detail; the finish paths already
mirror each other (`finishCodexUsageJobSafely` at `poll-loop.ts:765`).

### 2b. Persistent shared usage store

Usage stats live in **persistent shared memory**: a single JSON store at
`/workspace/agent/.nanoclaw/usage-store.json` — the same group workspace that
already persists codex's per-job snapshots (`.nanoclaw/codex-usage/`), so it
survives container respawns and is visible to every session of the group.

Schema:

```json
{
  "schema_version": "usage-store.v1",
  "updated_at": "2026-08-05T20:00:00Z",
  "codex": {
    "weekly_limit_used_percent": 38,
    "weekly_limit_remaining_percent": 62,
    "captured_at": "2026-08-05T19:58:00Z"
  },
  "deepseek": {
    "cumulative_total_tokens": 123456,
    "balance": { "currency": "USD", "total_balance": "12.40" },
    "captured_at": "2026-08-05T20:00:00Z"
  }
}
```

Rules:

- **Whichever provider runs refreshes its own row** and writes `updated_at`.
  A deepseek job fetches its balance from the fixed DeepSeek `/user/balance`
  endpoint (in-band through the OneCLI gateway — the same fixed host as chat
  completions, key injected in flight; **no new host bridge**). A codex job
  already derives `weekly_limit_remaining_percent` from the rate-limit snapshot
  it reads today; it writes that into the store.
- **Every report reads both rows.** This is how "show remaining usage for codex
  and deepseek even when only one is being used" works: a deepseek agent never
  shells out to the codex bridge (and vice versa) — it reads the last-known
  codex row from shared memory, and the codex path reads the last-known deepseek
  row the same way.
- A stale row (older than a threshold) is reported as `unavailable` rather than
  blocking the report, so the two halves never hard-depend on each other.

### 3. Report shape

Follow the codex formatter's style (`formatUsageDelta`): a short Discord text
block per user-facing query. The headline is the single figure that matters —
**`total_tokens`** — since that is the token cost of solving the problem,
regardless of reasoning vs. answer split. Then the cross-provider remaining
usage from the shared store. Example (a deepseek query while codex is idle):

```
DeepSeek usage for <job>:
- total tokens: 1,801
- model: deepseek-v4-flash
- DeepSeek balance remaining: USD 12.40 (~44,285,714 tokens remaining)
- Codex weekly limit remaining: 62%
```

A codex query shows the inverse ordering (codex usage headline, then the
deepseek balance from shared memory). The prompt/completion (and reasoning)
split is captured in the persisted audit record, never shown here. Cadence is
per user-facing query — codex parity.

### 4. What changes where

| File | Change |
|---|---|
| `container/agent-runner/src/providers/types.ts` | Add `ProviderUsage` + optional `usage` event to the union |
| `container/agent-runner/src/providers/deepseek.ts` | Read `body.usage`, accumulate per turn, emit `usage` event before `result` |
| `container/agent-runner/src/deepseek-usage-job.ts` (new) | Job record, per-job accumulation, shared-store update + `/user/balance` fetch, `formatDeepseekUsage`, `reportDeepseekUsage` (Discord-only, via `writeMessageOut`), audit snapshots under `.nanoclaw/deepseek-usage/` |
| `container/agent-runner/src/usage-store.ts` (new) | Read/write `usage-store.json` (shared-memory persistence) + `formatRemainingUsage` shared by both providers |
| `container/agent-runner/src/poll-loop.ts` | Start/finish the deepseek job in the same lifecycle points as the codex job; accumulate `usage` events; `case 'usage'` in `handleEvent` |
| `container/agent-runner/src/codex-usage-job.ts` | Writes its rate-limit `remaining_percent` into the shared store; its formatter reads the store to append the deepseek balance line |
| `src/usage-reader-bridge.ts`, `src/providers/codex.ts` | Untouched — still codex-only, still injected only for codex containers |

### 5. Security posture

- **No new egress.** Usage data comes from responses the provider already
  receives, plus the fixed DeepSeek `/user/balance` endpoint (same host as
  chat completions, through the existing gateway). Nothing new is fetched.
- **No host filesystem / Docker access.** The job runs inside the container
  and writes only through the existing `writeMessageOut` path and the shared
  workspace.
- **No secrets.** Token counts and balances are not credentials; the report
  never contains request/response bodies or keys.
- **No provider-agnostic broadening.** This is an additive, opt-in surface
  gated on `providerName === 'deepseek'`, exactly like the codex job is gated
  on `'codex'`. Other providers stay unaffected. Cross-provider display is
  read-only via the shared store — no provider calls another provider's bridge.

## Tests

- `container/agent-runner/src/providers/deepseek.test.ts` — extend: a faked
  `fetch` response with `usage` yields an aggregated `usage` event with summed
  totals across a tool-call round.
- `container/agent-runner/src/deepseek-usage-job.test.ts` (new) — `start`
  returns `null` for non-deepseek providers and non-Discord routing; `finish`
  emits one formatted `messages_out` row, writes a `.nanoclaw/deepseek-usage/`
  audit snapshot, and updates the shared store; a job with no usage emits
  nothing.
- `container/agent-runner/src/usage-store.test.ts` (new) — read/write
  round-trip; a stale/missing codex row renders `unavailable` and never blocks
  a deepseek report, and vice versa.
- `container/agent-runner/src/poll-loop.test.ts` — a `usage` event on the
  stream is captured and reported; absence is a no-op.
- `container/agent-runner/src/codex-usage-job.test.ts` — extend: the codex
  formatter appends the deepseek balance line from the shared store, and the
  job writes `weekly_limit_remaining_percent` into the store.
- `container/agent-runner/src/providers/types.test.ts` (if present) or the
  conformance test — the union change keeps the `switch (event.type)`
  exhaustive.

## Resolved decisions

1. **Cumulative / remaining usage** — The report shows remaining usage for
   **both** codex and deepseek, even when only one is in use. Stats persist in
   **shared memory** (`/workspace/agent/.nanoclaw/usage-store.json`), so a
   deepseek agent never calls the codex bridge and vice versa; each provider
   refreshes its own row, every report reads both rows.
2. **Persistence** — Yes: per-query `.nanoclaw/deepseek-usage/*.json` audit
   snapshots, mirroring codex's `.nanoclaw/codex-usage/`.
3. **Cadence** — Per user-facing query (codex parity). No scheduled roll-up.
4. **Model coverage** — RESOLVED. DeepSeek's thinking mode (default on) reports
   `reasoning_tokens` under `completion_tokens_details`; `completion_tokens`
   already includes them, and `total_tokens = prompt_tokens + completion_tokens`.
   The report's single headline figure is `total_tokens` — the true cost of
   solving the problem. The reasoning/answer split is captured and persisted
   internally for audit only, never shown on Discord.

## Rollout

Same pattern as PR #11: new branch off `codex/deepseek-native-provider`, commit
+ push, draft PR. No live config, secret, or agent changes — pure additive
reporting. The codex-side store writes and formatter additions land in the same
PR so the cross-provider display works in both directions from day one.

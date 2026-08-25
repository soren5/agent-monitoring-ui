# NanoClaw monitor publisher (M1)

The logical **agent group** is the monitored identity. Runtime and session IDs are provenance. The publisher owns an epoch `streamId` and monotonically increasing decimal-string sequence. A subscriber receives an authoritative projection snapshot (`asOf`) and then ordered events. Event IDs are deduplicated only while their events remain in the bounded replay suffix. Gaps, expired retention, or another epoch require snapshot reconciliation. Disconnect only marks cached data stale.

## Transport and security

M1 uses a streaming local filesystem Unix-domain socket through Node `net`, rather than loopback WebSocket. It has no HTTP upgrade dependency, does not bind a network interface, and is set to owner-only mode (`0600`). A Windows named-pipe path is not implemented. Application tokens authenticate clients; monitoring, private reasoning, and messaging grants are independent.

Events and snapshots validate the supported major protocol version, cursors, timestamps, optional provenance, agent projections, and known event payload fields. Unknown fields remain available for compatible minor-version extensions. The publisher redacts values under common secret-shaped structured keys and a conservative set of common credential patterns in free text before projection, retention, and broadcast. This is defense in depth, not perfect secret detection: novel formats, split credentials, and ambiguous prose can evade pattern matching. Reasoning content is additionally removed for clients without its grant.

## Projection, retention, and backpressure

History is an in-memory bounded replay suffix, not durable M2 history. Retained events and dedupe IDs have the same bound. A session-changing upsert (or agent removal) clears the replay suffix before the boundary event so previous-session events cannot be resumed. Because the cursor is global, this clears replay history for every agent; older clients reconcile from the projection snapshot. Same-session upserts preserve the suffix.

Status, command, chat, errors, and terminal tool events are non-droppable. Only activity/reasoning/tool progress may be coalesced. The publisher supplies `coalescedCount` for coalesced progress. Normal events are emitted synchronously; the configured progress flusher uses a five-second maximum delay. Fifty-agent and ten-concurrent-update fixtures exercise ordering and throughput but are not a universal latency guarantee.

## Provider gaps

Provider adapters declare the reasoning availability they can prove: the current runner mapping reports Claude summary, Codex activity-only, DeepSeek none, and unknown providers unknown. Snapshot seeding remains unknown except for explicit effort `none` or the `openai-compatible` provider. Reasoning content is valid only for `full` or `summary`. Structured monitor telemetry is written to its dedicated telemetry path rather than inserted into user-visible chat.

## Messaging

`agent.message.send` is routed through the existing host delivery callback. `commandId` is idempotent: identical retries return the saved outcome and changed bodies conflict. Ack is persisted acceptance, never delivery; success/failure is emitted separately. Runtime composition uses the SQLite-backed durable `CommandStore`; the in-memory implementation is test-only.

The sample client authenticates, optionally resumes from a cursor file, validates newline framing and protocol data, detects cursor gaps/epoch changes, and reconnects without a cursor to obtain a fresh snapshot. It can also issue one message command after synchronization:

```sh
NANOCLAW_MONITOR_TOKEN=... \
NANOCLAW_MONITOR_CURSOR_FILE=/tmp/nanoclaw-monitor.cursor \
pnpm tsx scripts/monitor-client.ts data/monitor.sock [agentGroupId message...]
```

The sample cursor file is local convenience state, not durable monitor history. Command acknowledgements and later success/failure events retain their separate meanings.

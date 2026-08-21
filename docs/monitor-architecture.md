# NanoClaw monitor publisher (M1)

The logical **agent group** is the monitored identity. Runtime and session IDs are provenance only. The publisher owns an epoch `streamId` and monotonically increasing decimal-string sequence. A subscriber receives an authoritative current-session snapshot (`asOf`) and then ordered events. Duplicate IDs are ignored; gaps, expired retention, or another epoch require snapshot reconciliation. Disconnect only marks cached data stale.

## Transport and security

M1 uses a streaming local Unix socket (Node `net`; named pipe on Windows), rather than loopback WebSocket. Both permit push, but the socket has no HTTP upgrade/dependency, cannot bind a network interface, and provides OS owner/mode authentication (`0600`). Application tokens authenticate clients; monitoring, private reasoning, and messaging grants are independent. Secret-shaped fields are redacted before retention/broadcast and reasoning content is removed without its grant.

## Projection, retention, and backpressure

History is a bounded current-session projection, not durable M2 history. Status, command, chat, errors, and terminal tool events are non-droppable. Only activity/reasoning/tool progress may be coalesced; producers should include `coalescedCount`. Normal events are emitted synchronously (well inside the two-second objective); progress flushers must use at most five seconds. Fifty agents and ten concurrent updates have deterministic contract fixtures.

## Provider gaps

Claude exposes reasoning summaries, Codex activity-only reasoning, DeepSeek none, and unknown providers `unknown`. Content exists only for `full`/`summary`. Structured telemetry is never inserted into user-visible chat.

## Messaging

`agent.message.send` is routed through the existing host delivery callback. `commandId` is idempotent: identical retries return the saved outcome and changed bodies conflict. Ack is persisted acceptance, never delivery; success/failure is emitted separately. Runtime composition uses the SQLite-backed durable `CommandStore`; the in-memory implementation is test-only.

Sample: `NANOCLAW_MONITOR_TOKEN=... pnpm tsx scripts/monitor-client.ts data/monitor.sock`.

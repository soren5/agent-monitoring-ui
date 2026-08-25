import { beforeEach, describe, expect, test } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { appendProviderTelemetry } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import {
  drainRunnerTelemetry,
  MemoryTelemetryHighWater,
  type DrainedTelemetrySink,
} from '../../../src/monitor/runner-telemetry-drainer.js';

class FakeProvider implements AgentProvider {
  readonly name = 'fake';
  readonly capabilities = { nativeSlashCommands: false };
  query(): AgentQuery {
    const events: ProviderEvent[] = [
      { type: 'reasoning', availability: 'summary', content: 'checking' },
      { type: 'tool', phase: 'start', name: 'search', toolCallId: 'call-1' },
      { type: 'tool', phase: 'complete', name: 'search', toolCallId: 'call-1', detail: { ok: true } },
      { type: 'output', text: 'done' },
      { type: 'status', status: 'idle' },
    ];
    return {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      },
    };
  }
  isSessionInvalid(): boolean {
    return false;
  }
}

describe('ProviderEvent telemetry boundary', () => {
  beforeEach(() => {
    closeSessionDb();
    initTestSessionDb();
  });

  test('orders provenance through outbound DB and drains duplicate-safely without messages_out', async () => {
    const provider = new FakeProvider();
    const query = provider.query({ prompt: 'test', cwd: '/tmp' });
    for await (const event of query.events) appendProviderTelemetry(event, provider.name, 'agent-1');

    const db = getOutboundDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
    const persisted = db.prepare('SELECT seq, type FROM runner_telemetry ORDER BY seq').all() as Array<{
      seq: number;
      type: string;
    }>;
    expect(persisted.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);

    const highWater = new MemoryTelemetryHighWater();
    const monitor: Array<Parameters<DrainedTelemetrySink>[0]> = [];
    const seen = new Set<string>();
    const sink: DrainedTelemetrySink = (row) => {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        monitor.push(row);
      }
    };
    drainRunnerTelemetry(db as never, 'session-1', highWater, sink);
    drainRunnerTelemetry(db as never, 'session-1', highWater, sink);

    expect(monitor.map((row) => row.type)).toEqual([
      'reasoning.progress',
      'tool.start',
      'tool.complete',
      'output',
      'agent.status',
    ]);
    expect(
      monitor.every((row) => row.provenance.provider === 'fake' && row.provenance.agentGroupId === 'agent-1'),
    ).toBe(true);
    expect(highWater.get('session-1')).toBe(5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
  });
});

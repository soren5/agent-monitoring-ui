import net from 'net';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCommandStore, MessageCommandHandler } from './commands.js';
import { MonitorPublisher, ProgressCoalescer } from './publisher.js';
import { drainRunnerTelemetryThroughCoalescer, MemoryTelemetryHighWater } from './runner-telemetry-drainer.js';
import { startMonitorServer } from './transport.js';

const servers: net.Server[] = [];
const clients: net.Socket[] = [];
afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.length = 0;
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe('runner telemetry production path', () => {
  it('streams SQLite rows through the drainer and coalescer to the Unix socket', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runner_telemetry (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, occurred_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, provenance_json TEXT NOT NULL
    )`);
    const insert = db.prepare(`INSERT INTO runner_telemetry
      (id, seq, occurred_at, schema_version, type, payload_json, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('row-1', 1, '2026-08-27T00:00:01.000Z', 1, 'tool.progress', '{"pct":10}', '{"itemId":"a"}');
    insert.run('row-2', 2, '2026-08-27T00:00:02.000Z', 1, 'tool.progress', '{"pct":20}', '{"itemId":"b"}');
    insert.run('row-3', 3, '2026-08-27T00:00:03.000Z', 1, 'error', '{"message":"boom"}', '{"itemId":"c"}');

    const publisher = new MonitorPublisher();
    const coalescer = new ProgressCoalescer(publisher, 5000);
    const commands = new MessageCommandHandler(new MemoryCommandStore(), async () => ({ queued: true }), publisher);
    const socketPath = path.join(os.tmpdir(), `runner-monitor-${process.pid}-${Date.now()}.sock`);
    const server = await startMonitorServer(socketPath, publisher, commands, {
      authenticate: (token) =>
        token === 'ok' ? { monitor: true, privateReasoning: false, message: false } : undefined,
    });
    servers.push(server);

    const received: Array<Record<string, unknown>> = [];
    const client = net.createConnection(socketPath);
    clients.push(client);
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) received.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write('{"token":"ok"}\n');
    await expect.poll(() => received[0]?.kind).toBe('snapshot');

    const highWater = new MemoryTelemetryHighWater();
    expect(drainRunnerTelemetryThroughCoalescer(db, 'session-1', 'group-1', highWater, coalescer)).toBe(3);
    await expect.poll(() => received.filter((frame) => frame.kind === 'event').length).toBe(2);
    const events = received.filter((frame) => frame.kind === 'event').map((frame) => frame.event);
    expect(events).toMatchObject([
      {
        type: 'tool.progress',
        eventId: 'row-2',
        sessionId: 'session-1',
        coalescedCount: 2,
        payload: { pct: 20, provenance: { itemId: 'b' }, occurredAt: '2026-08-27T00:00:02.000Z', schemaVersion: 1 },
      },
      {
        type: 'error',
        eventId: 'row-3',
        sessionId: 'session-1',
        payload: { message: 'boom', provenance: { itemId: 'c' } },
      },
    ]);
    expect(highWater.get('session-1')).toBe(3);
    coalescer.close();
    db.close();
  });
});

import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migration034 } from '../db/migrations/034-monitor-commands.js';
import { migration036 } from '../db/migrations/036-monitor-command-state.js';
import { MemoryCommandStore, MessageCommandHandler, SqliteCommandStore } from './commands.js';
import { MonitorPublisher } from './publisher.js';

const command = { commandId: 'same', agentGroupId: 'g', body: 'hello' };
function schema(db: Database.Database): void {
  migration034.up(db);
  migration036.up(db);
}

describe('durable message commands', () => {
  it('forward-migrates existing command outcomes as terminal records', () => {
    const db = new Database(':memory:');
    migration034.up(db);
    db.prepare(`INSERT INTO monitor_command_outcomes VALUES(?,?,?,?,?)`).run(
      'legacy',
      'h',
      JSON.stringify({ commandId: 'legacy', status: 'success' }),
      'now',
      'now',
    );
    migration036.up(db);
    expect(db.prepare('SELECT state,attempts FROM monitor_command_outcomes').get()).toEqual({
      state: 'delivered',
      attempts: 0,
    });
    db.close();
  });
  it('is idempotent and detects changed bodies', async () => {
    const delivery = vi.fn(async () => ({ queued: true, wakeRequested: true }));
    const handler = new MessageCommandHandler(new MemoryCommandStore(), delivery, new MonitorPublisher());
    expect((await handler.handle(command)).status).toBe('success');
    expect(await handler.handle(command)).toMatchObject({ status: 'success', code: 'queued' });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(await handler.handle({ ...command, body: 'changed' })).toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    });
  });

  it('atomically claims same-ID races across store instances and persists the outcome', async () => {
    const file = path.join(os.tmpdir(), `monitor-command-${process.pid}-${Date.now()}.sqlite`);
    const db1 = new Database(file);
    schema(db1);
    const db2 = new Database(file);
    db2.pragma('busy_timeout = 1000');
    const delivery = vi.fn(async () => ({ queued: true, wakeRequested: true }));
    const first = new MessageCommandHandler(new SqliteCommandStore(db1), delivery, new MonitorPublisher());
    const second = new MessageCommandHandler(new SqliteCommandStore(db2), delivery, new MonitorPublisher());
    const outcomes = await Promise.all([first.handle(command), second.handle(command)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['ack', 'success']);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(await second.handle({ ...command, agentGroupId: 'other' })).toMatchObject({ code: 'idempotency_conflict' });
    db1.close();
    db2.close();
    fs.unlinkSync(file);
  });

  it('recovers accepted/delivering/retryable records without duplicating stable downstream writes', async () => {
    const db = new Database(':memory:');
    schema(db);
    const store = new SqliteCommandStore(db);
    store.claim(command, 'hash');
    const writes = new Set<string>();
    const delivery = vi.fn(async (_group: string, _body: string, id: string) => {
      writes.add(id);
      return { queued: true, wakeRequested: false, detail: 'wake_failed_message_remains_queued' };
    });
    const handler = new MessageCommandHandler(store, delivery, new MonitorPublisher());
    await handler.recover();
    await new MessageCommandHandler(new SqliteCommandStore(db), delivery, new MonitorPublisher()).recover();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(new Set(['same']));
    expect(
      (store.claim(command, 'hash') as { kind: 'existing'; record: { outcome: unknown } }).record.outcome,
    ).toMatchObject({ status: 'success', code: 'queued_wake_failed' });
    db.close();
  });

  it('leaves exceptions retryable and completes them on restart', async () => {
    const db = new Database(':memory:');
    schema(db);
    const store = new SqliteCommandStore(db);
    const failed = new MessageCommandHandler(
      store,
      async () => {
        throw new Error('crash after claim');
      },
      new MonitorPublisher(),
    );
    expect(await failed.handle(command)).toMatchObject({ code: 'delivery_exception', retryable: true });
    const recovered = vi.fn(async () => ({ queued: true, wakeRequested: true }));
    await new MessageCommandHandler(new SqliteCommandStore(db), recovered, new MonitorPublisher()).recover();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(
      (store.claim(command, createHashForTest(command)) as { kind: 'existing'; record: { outcome: unknown } }).record
        .outcome,
    ).toMatchObject({ status: 'success' });
    db.close();
  });
});

function createHashForTest(value: typeof command): string {
  return createHash('sha256').update(`${value.agentGroupId}\0${value.body}`).digest('hex');
}

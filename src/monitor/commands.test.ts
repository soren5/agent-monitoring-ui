import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryCommandStore, MessageCommandHandler, SqliteCommandStore } from './commands.js';
import { MonitorPublisher } from './publisher.js';
describe('message commands', () => {
  it('is idempotent and detects changed bodies', async () => {
    const d = vi.fn(async () => ({ delivered: true }));
    const h = new MessageCommandHandler(new MemoryCommandStore(), d, new MonitorPublisher());
    const c = { commandId: '1', agentGroupId: 'g', body: 'hello' };
    expect((await h.handle(c)).status).toBe('success');
    expect(await h.handle(c)).toEqual(expect.objectContaining({ status: 'success' }));
    expect(d).toHaveBeenCalledTimes(1);
    expect(await h.handle({ ...c, body: 'changed' })).toMatchObject({ code: 'idempotency_conflict' });
  });
  it('reports inactive/failure outcomes', async () => {
    const h = new MessageCommandHandler(
      new MemoryCommandStore(),
      async () => ({ delivered: false, detail: 'inactive' }),
      new MonitorPublisher(),
    );
    expect(await h.handle({ commandId: '2', agentGroupId: 'g', body: 'x' })).toMatchObject({
      status: 'failure',
      code: 'delivery_failed',
      detail: 'inactive',
    });
  });
  it('persists idempotent outcomes across handler instances', async () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE monitor_command_outcomes(command_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,outcome_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
    );
    const delivery = vi.fn(async () => ({ delivered: true }));
    const c = { commandId: 'durable', agentGroupId: 'g', body: 'hello' };
    await new MessageCommandHandler(new SqliteCommandStore(db), delivery, new MonitorPublisher()).handle(c);
    expect(
      (await new MessageCommandHandler(new SqliteCommandStore(db), delivery, new MonitorPublisher()).handle(c)).status,
    ).toBe('success');
    expect(delivery).toHaveBeenCalledTimes(1);
    db.close();
  });
});

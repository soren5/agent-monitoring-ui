import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCommandStore, MessageCommandHandler } from './commands.js';
import { MonitorPublisher } from './publisher.js';
import { startMonitorServer } from './transport.js';
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
});
function request(sock: string, frame: unknown) {
  return new Promise<string>((resolve, reject) => {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(frame) + '\n'));
    c.once('data', (d) => {
      resolve(d.toString());
      c.destroy();
    });
    c.once('error', reject);
  });
}
describe('local monitor transport', () => {
  it('rejects unauthenticated access and uses owner-only socket', async () => {
    const sock = path.join(os.tmpdir(), `monitor-${process.pid}-${Date.now()}.sock`);
    const p = new MonitorPublisher();
    const h = new MessageCommandHandler(new MemoryCommandStore(), async () => ({ delivered: true }), p);
    const s = await startMonitorServer(sock, p, h, {
      authenticate: (t) => (t === 'ok' ? { monitor: true, privateReasoning: false, message: true } : undefined),
    });
    servers.push(s);
    expect(await request(sock, { token: 'bad' })).toContain('unauthenticated');
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    expect(await request(sock, { token: 'ok' })).toContain('snapshot');
  });
  it('authorizes private reasoning and messaging separately', async () => {
    const sock = path.join(os.tmpdir(), `monitor-grants-${process.pid}-${Date.now()}.sock`);
    const p = new MonitorPublisher();
    p.publish('agent.upsert', 'g', {
      status: 'idle',
      hasBlockers: false,
      reasoningAvailability: 'full',
      reasoningContent: 'private',
    });
    const h = new MessageCommandHandler(new MemoryCommandStore(), async () => ({ delivered: true }), p);
    const s = await startMonitorServer(sock, p, h, {
      authenticate: (t) => (t === 'limited' ? { monitor: true, privateReasoning: false, message: false } : undefined),
    });
    servers.push(s);
    const first = await request(sock, { token: 'limited' });
    expect(first).not.toContain('private');
    const response = await new Promise<string>((resolve, reject) => {
      const c = net.createConnection(sock, () =>
        c.write(
          JSON.stringify({ token: 'limited' }) +
            '\n' +
            JSON.stringify({ type: 'agent.message.send', command: { commandId: 'x', agentGroupId: 'g', body: 'hi' } }) +
            '\n',
        ),
      );
      let data = '';
      c.on('data', (d) => {
        data += d;
        if (data.includes('forbidden')) {
          resolve(data);
          c.destroy();
        }
      });
      c.on('error', reject);
    });
    expect(response).toContain('forbidden');
  });
});

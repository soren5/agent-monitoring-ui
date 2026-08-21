import fs from 'fs';
import net from 'net';
import type { Cursor } from './protocol.js';
import type { MonitorPublisher } from './publisher.js';
import type { MessageCommandHandler } from './commands.js';
export interface MonitorGrants {
  monitor: boolean;
  privateReasoning: boolean;
  message: boolean;
}
export interface MonitorAuth {
  authenticate(token: string): MonitorGrants | undefined;
}
/**
 * Streaming Unix socket was selected over loopback WebSocket: it inherits OS
 * owner/mode controls, needs no HTTP upgrade dependency, cannot accidentally
 * bind externally, and newline JSON supports snapshot then push. Windows named
 * pipes use the same Node `net` framing. See docs/monitor-architecture.md.
 */
export function startMonitorServer(
  path: string,
  publisher: MonitorPublisher,
  commands: MessageCommandHandler,
  auth: MonitorAuth,
): Promise<net.Server> {
  try {
    fs.unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const server = net.createServer((socket) => {
    let authorized: MonitorGrants | undefined;
    let buffer = '';
    const visible = <T>(value: T): T => {
      if (authorized?.privateReasoning) return value;
      const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (!v || typeof v !== 'object') return v;
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) {
          if (k === 'reasoningContent') continue;
          if (k === 'payload' && o.type === 'reasoning.progress' && x && typeof x === 'object') {
            const { content: _, ...rest } = x as Record<string, unknown>;
            out[k] = walk(rest);
          } else out[k] = walk(x);
        }
        return out;
      };
      return walk(value) as T;
    };
    const onEvent = (event: unknown) => socket.write(JSON.stringify(visible({ kind: 'event', event })) + '\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        void (async () => {
          try {
            const f = JSON.parse(line) as Record<string, unknown>;
            if (!authorized) {
              authorized = auth.authenticate(String(f.token ?? ''));
              if (!authorized?.monitor) {
                socket.end(JSON.stringify({ error: 'unauthenticated' }) + '\n');
                return;
              }
              const resumed = publisher.resume(f.after as Cursor | undefined);
              socket.write(JSON.stringify(visible(resumed)) + '\n');
              publisher.on('event', onEvent);
              return;
            }
            if (f.type === 'agent.message.send') {
              if (!authorized.message) {
                socket.write(JSON.stringify({ error: 'forbidden' }) + '\n');
                return;
              }
              socket.write(JSON.stringify(await commands.handle(f.command as never)) + '\n');
            }
          } catch (error) {
            if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError))
              throw error;
            socket.end(JSON.stringify({ error: 'invalid_frame' }) + '\n');
          }
        })();
      }
    });
    socket.on('close', () => publisher.off('event', onEvent));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      fs.chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

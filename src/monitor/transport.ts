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
export const MONITOR_CLIENT_QUEUE_MAX_MESSAGES = 256;
export const MONITOR_CLIENT_QUEUE_MAX_BYTES = 1024 * 1024;
export const MONITOR_AUTH_TIMEOUT_MS = 5_000;
export const MONITOR_MAX_FRAME_BYTES = 64 * 1024;
export const MONITOR_MAX_INBOUND_BUFFER_BYTES = 128 * 1024;
export const MONITOR_MAX_CONNECTIONS = 64;
export const MONITOR_MAX_COMMANDS_PER_CLIENT = 4;
export const MONITOR_MAX_COMMANDS_GLOBAL = 32;
export const MONITOR_RATE_WINDOW_MS = 10_000;
export const MONITOR_MAX_FRAMES_PER_WINDOW = 120;
export const MONITOR_SHUTDOWN_GRACE_MS = 500;

export interface MonitorTransportOptions {
  authTimeoutMs?: number;
  maxFrameBytes?: number;
  maxInboundBufferBytes?: number;
  maxConnections?: number;
  maxCommandsPerClient?: number;
  maxCommandsGlobal?: number;
  rateWindowMs?: number;
  maxFramesPerWindow?: number;
  shutdownGraceMs?: number;
  /** Per-client outbound queue cap in frames (default MONITOR_CLIENT_QUEUE_MAX_MESSAGES). */
  clientQueueMaxMessages?: number;
  /** Per-client outbound queue cap in bytes (default MONITOR_CLIENT_QUEUE_MAX_BYTES). */
  clientQueueMaxBytes?: number;
}

class ClientOutboundQueue {
  private frames: Array<{ data: string; bytes: number }> = [];
  private bytes = 0;
  private blocked = false;
  private closed = false;
  constructor(
    private readonly socket: net.Socket,
    private readonly overflow: () => void,
    private readonly maxMessages = MONITOR_CLIENT_QUEUE_MAX_MESSAGES,
    private readonly maxBytes = MONITOR_CLIENT_QUEUE_MAX_BYTES,
  ) {
    socket.on('drain', this.onDrain);
    socket.on('close', this.close);
  }
  send(value: unknown): boolean {
    if (this.closed) return false;
    const data = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > this.maxBytes) {
      this.overflow();
      this.socket.destroy();
      this.close();
      return false;
    }
    if (this.blocked || this.frames.length) {
      if (this.frames.length + 1 > this.maxMessages || this.bytes + bytes > this.maxBytes) {
        this.overflow();
        this.socket.destroy();
        this.close();
        return false;
      }
      this.frames.push({ data, bytes });
      this.bytes += bytes;
      return true;
    }
    this.blocked = !this.socket.write(data);
    return true;
  }
  private readonly onDrain = (): void => {
    this.blocked = false;
    while (!this.blocked && this.frames.length) {
      const frame = this.frames.shift()!;
      this.bytes -= frame.bytes;
      this.blocked = !this.socket.write(frame.data);
    }
  };
  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.frames = [];
    this.bytes = 0;
    this.socket.off('drain', this.onDrain);
    this.socket.off('close', this.close);
  };
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
  options: MonitorTransportOptions = {},
): Promise<net.Server> {
  try {
    fs.unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const clients = new Set<net.Socket>();
  const snapshotRequiredTokens = new Set<string>();
  const limits = {
    authTimeoutMs: options.authTimeoutMs ?? MONITOR_AUTH_TIMEOUT_MS,
    maxFrameBytes: options.maxFrameBytes ?? MONITOR_MAX_FRAME_BYTES,
    maxInboundBufferBytes: options.maxInboundBufferBytes ?? MONITOR_MAX_INBOUND_BUFFER_BYTES,
    maxConnections: options.maxConnections ?? MONITOR_MAX_CONNECTIONS,
    maxCommandsPerClient: options.maxCommandsPerClient ?? MONITOR_MAX_COMMANDS_PER_CLIENT,
    maxCommandsGlobal: options.maxCommandsGlobal ?? MONITOR_MAX_COMMANDS_GLOBAL,
    rateWindowMs: options.rateWindowMs ?? MONITOR_RATE_WINDOW_MS,
    maxFramesPerWindow: options.maxFramesPerWindow ?? MONITOR_MAX_FRAMES_PER_WINDOW,
    shutdownGraceMs: options.shutdownGraceMs ?? MONITOR_SHUTDOWN_GRACE_MS,
    clientQueueMaxMessages: options.clientQueueMaxMessages ?? MONITOR_CLIENT_QUEUE_MAX_MESSAGES,
    clientQueueMaxBytes: options.clientQueueMaxBytes ?? MONITOR_CLIENT_QUEUE_MAX_BYTES,
  };
  let globalCommands = 0;
  let admittedConnections = 0;
  const server = net.createServer((socket) => {
    if (admittedConnections >= limits.maxConnections) {
      clients.add(socket);
      socket.once('close', () => clients.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.end(JSON.stringify({ error: 'connection_limit' }) + '\n');
      return;
    }
    clients.add(socket);
    admittedConnections++;
    let authorized: MonitorGrants | undefined;
    let authToken = '';
    let buffer = '';
    let clientCommands = 0;
    let rateWindowStarted = Date.now();
    let framesInWindow = 0;
    const authTimer = setTimeout(() => {
      terminate('authentication_timeout');
    }, limits.authTimeoutMs);
    authTimer.unref();
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
    const outbound = new ClientOutboundQueue(
      socket,
      () => {
        if (authToken) snapshotRequiredTokens.add(authToken);
      },
      limits.clientQueueMaxMessages,
      limits.clientQueueMaxBytes,
    );
    const send = (value: unknown): boolean => outbound.send(visible(value));
    const terminate = (error: string): void => {
      send({ error });
      socket.end();
      setTimeout(() => socket.destroy(), 10).unref();
    };
    const onEvent = (event: unknown) => send({ kind: 'event', event });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > limits.maxInboundBufferBytes) {
        terminate('inbound_buffer_limit');
        return;
      }
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (Buffer.byteLength(line) > limits.maxFrameBytes) {
          terminate('frame_too_large');
          return;
        }
        const now = Date.now();
        if (now - rateWindowStarted >= limits.rateWindowMs) {
          rateWindowStarted = now;
          framesInWindow = 0;
        }
        framesInWindow++;
        if (framesInWindow > limits.maxFramesPerWindow) {
          terminate('rate_limit');
          return;
        }
        void (async () => {
          try {
            const f = JSON.parse(line) as Record<string, unknown>;
            if (!authorized) {
              authToken = String(f.token ?? '');
              authorized = auth.authenticate(authToken);
              if (!authorized?.monitor) {
                send({ error: 'unauthenticated' });
                socket.end();
                return;
              }
              clearTimeout(authTimer);
              const forceSnapshot = snapshotRequiredTokens.delete(authToken);
              const resumed = publisher.resume(forceSnapshot ? undefined : (f.after as Cursor | undefined));
              send(resumed);
              publisher.on('event', onEvent);
              return;
            }
            if (f.type === 'agent.message.send') {
              if (!authorized.message) {
                send({ error: 'forbidden' });
                return;
              }
              if (clientCommands >= limits.maxCommandsPerClient || globalCommands >= limits.maxCommandsGlobal) {
                terminate('command_concurrency_limit');
                return;
              }
              clientCommands++;
              globalCommands++;
              try {
                send(await commands.handle(f.command as never));
              } finally {
                clientCommands--;
                globalCommands--;
              }
            }
          } catch (error) {
            if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError))
              throw error;
            send({ error: 'invalid_frame' });
            socket.end();
          }
        })();
      }
    });
    socket.on('close', () => {
      admittedConnections--;
      clearTimeout(authTimer);
      clients.delete(socket);
      outbound.close();
      publisher.off('event', onEvent);
    });
    socket.on('error', () => socket.destroy());
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    // Stop accepting immediately, then allow already-written frames a short
    // grace before forcibly releasing half-open or paused peers.
    for (const client of clients) client.end();
    const force = setTimeout(() => {
      for (const client of clients) client.destroy();
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }, limits.shutdownGraceMs);
    return originalClose((err?: Error) => {
      clearTimeout(force);
      for (const client of clients) client.destroy();
      clients.clear();
      try {
        fs.unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
      callback?.(err);
    });
  }) as typeof server.close;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      fs.chmodSync(path, 0o600);
      resolve(server);
    });
  });
}


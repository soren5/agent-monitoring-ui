import { randomUUID } from 'crypto';
import fs from 'fs';
import net from 'net';
import { SampleClientCursor, validateServerFrame } from '../src/monitor/sample-client.js';
import type { Cursor } from '../src/monitor/protocol.js';

const socketPath = process.argv[2] ?? 'data/monitor.sock';
const agentGroupId = process.argv[3];
const message = process.argv.slice(4).join(' ') || undefined;
const token = process.env.NANOCLAW_MONITOR_TOKEN;
const cursorFile = process.env.NANOCLAW_MONITOR_CURSOR_FILE;
if (!token) throw new Error('NANOCLAW_MONITOR_TOKEN is required');
if ((agentGroupId && !message) || (!agentGroupId && message))
  throw new Error('usage: monitor-client.ts [socket] [agentGroupId message]');

function readCursor(): Cursor | undefined {
  if (!cursorFile) return undefined;
  try {
    return JSON.parse(fs.readFileSync(cursorFile, 'utf8')) as Cursor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function saveCursor(cursor: Cursor | undefined): void {
  if (cursorFile && cursor) fs.writeFileSync(cursorFile, JSON.stringify(cursor) + '\n', { mode: 0o600 });
}

let after = readCursor();
let reconnectTimer: NodeJS.Timeout | undefined;
let commandSent = false;
function connect(forceSnapshot = false): void {
  const cursor = new SampleClientCursor(forceSnapshot ? undefined : after);
  let buffer = '';
  let reconciling = false;
  const socket = net.createConnection(socketPath, () =>
    socket.write(JSON.stringify({ token, ...(cursor.cursor() ? { after: cursor.cursor() } : {}) }) + '\n'),
  );
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) return socket.destroy(new Error('inbound_buffer_limit'));
    let split: number;
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line) continue;
      try {
        const frame = validateServerFrame(JSON.parse(line));
        const result = cursor.apply(frame);
        if (result === 'reconcile') {
          reconciling = true;
          after = undefined;
          socket.destroy();
          return;
        }
        after = cursor.cursor();
        saveCursor(after);
        process.stdout.write(JSON.stringify(frame) + '\n');
        if (!commandSent && agentGroupId && message && (frame.kind === 'snapshot' || frame.kind === 'events')) {
          commandSent = true;
          socket.write(
            JSON.stringify({
              type: 'agent.message.send',
              command: { commandId: randomUUID(), agentGroupId, body: message },
            }) + '\n',
          );
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        socket.destroy(error);
      }
    }
  });
  socket.on('error', (error) => process.stderr.write(`monitor error: ${error.message}\n`));
  socket.on('close', () => {
    process.stderr.write('monitor disconnected; displayed state is stale\n');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(reconciling), 500);
  });
}
connect();

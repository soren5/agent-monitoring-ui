/**
 * Fixed-function host bridge for the isolated Codex rate-limit reader.
 *
 * The agent container may request exactly one operation: POST /snapshot.
 * This module never accepts a command, path, URL, arguments, or script from
 * the container. The only executable it can start is Codex app-server with
 * one hard-coded, read-only rate-limit RPC.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { log } from './log.js';

export const USAGE_READER_BRIDGE_PORT = 32179;
export const USAGE_READER_BRIDGE_PATH = '/snapshot';
export const USAGE_READER_BRIDGE_URL = `http://host.docker.internal:${USAGE_READER_BRIDGE_PORT}${USAGE_READER_BRIDGE_PATH}`;

const HELPER_TIMEOUT_MS = 10_000;
const HELPER_MAX_BUFFER = 1024 * 1024;
const CODEX_RATE_LIMIT_REQUEST_ID = 2;
const CODEX_BIN = path.join(process.env.HOME ?? '', '.local', 'bin', 'codex');

let server: http.Server | undefined;

export async function startUsageReaderBridge(): Promise<void> {
  if (server) return;

  const nextServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  nextServer.on('error', (err) => log.error('Usage reader bridge error', { err }));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      nextServer.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      nextServer.off('error', onError);
      resolve();
    };
    nextServer.once('error', onError);
    nextServer.once('listening', onListening);
    // Docker Desktop maps host.docker.internal to this host loopback address.
    // Do not bind a LAN interface: the bridge is a container-only capability.
    nextServer.listen(USAGE_READER_BRIDGE_PORT, '127.0.0.1');
  });

  server = nextServer;
  log.info('Usage reader bridge started', { port: USAGE_READER_BRIDGE_PORT });
}

export async function stopUsageReaderBridge(): Promise<void> {
  if (!server) return;
  const activeServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => activeServer.close((err) => (err ? reject(err) : resolve())));
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== 'POST' || request.url !== USAGE_READER_BRIDGE_PATH) {
    sendJson(response, 404, { ok: false, error: 'Not found' });
    return;
  }

  // Deliberately ignore all request data. There are no caller-controlled
  // parameters, so this endpoint cannot become a general host command proxy.
  const result = await readUsageSnapshot();
  sendJson(response, result.ok ? 200 : 503, result);
}

async function readUsageSnapshot(): Promise<{ ok: true; snapshot: unknown } | { ok: false; error: string }> {
  try {
    const rateLimits = await readCodexRateLimits();
    return { ok: true, snapshot: { source: 'Codex CLI account/rateLimits/read', rateLimits } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Codex rate-limit reader is unavailable: ${detail}` };
  }
}

function readCodexRateLimits(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawn(CODEX_BIN, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill('SIGTERM');
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(
      () => settle(new Error(`Codex rate-limit request timed out after ${HELPER_TIMEOUT_MS}ms`)),
      HELPER_TIMEOUT_MS,
    );
    const send = (message: unknown): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-HELPER_MAX_BUFFER);
    });
    child.on('error', (err) => settle(err));
    child.on('close', (code) => {
      if (!settled) settle(new Error(`Codex rate-limit reader exited before responding (code ${code}; ${stderr})`));
    });
    if (!child.stdout || !child.stdin) return settle(new Error('Codex rate-limit reader did not expose stdio pipes'));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: CODEX_RATE_LIMIT_REQUEST_ID, method: 'account/rateLimits/read', params: null });
      } else if (message.id === CODEX_RATE_LIMIT_REQUEST_ID) {
        settle(message.error ? new Error(JSON.stringify(message.error)) : message.result);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'nanoclaw-rate-limit-reader', version: '1.0.0' }, capabilities: null },
    });
  });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

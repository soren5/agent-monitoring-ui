import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat } from './db/connection.js';
import type { RoutingContext } from './formatter.js';
import { formatRemainingUsage, updateCodexRow } from './usage-store.js';

const SNAPSHOT_TIMEOUT_MS = 10_000;
const HOST_USAGE_READER_BRIDGE_TIMEOUT_MS = 30_000;
const SNAPSHOT_MAX_BUFFER = 1024 * 1024;
const FALLBACK_APP_SERVER_USAGE_COMMAND = ['nanoclaw-codex-app-server'] as const;
const HOST_USAGE_READER_BRIDGE_COMMAND = ['nanoclaw-host-usage-reader'] as const;
const USAGE_READER_ROOTS = [
  '/workspace/extra/usage-reader',
  '/workspace/agent/usage-reader',
  '/workspace/usage-reader',
  '/usage-reader',
] as const;
const APP_SERVER_USAGE_REQUEST_ID = 2;
const USAGE_DIR = '.nanoclaw/codex-usage';

export interface CodexUsageSnapshot {
  schema_version: 'codex-usage-snapshot.v1';
  phase: 'pre' | 'post';
  job_id: string;
  captured_at: string;
  command: string[];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  parsed_json?: unknown;
  numeric_values: Record<string, number>;
}

export interface CodexUsageJob {
  id: string;
  cwd: string;
  routing: RoutingContext;
  prePath: string;
  pre: CodexUsageSnapshot;
}

export interface CodexUsageDelta {
  job_id: string;
  pre_path: string;
  post_path: string;
  command: string[];
  deltas: Record<string, number>;
  current_values?: Record<string, number>;
  unavailable_reason?: string;
}

type UsageCommandRunner = (
  command: string[],
  cwd: string,
) => Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>>;

let commandRunner: UsageCommandRunner = runCodexUsageCommand;

function log(msg: string): void {
  console.error(`[codex-usage-job] ${msg}`);
}

function generateId(): string {
  return `codex-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test seam only. Production uses the usage-reader/app-server command runner. */
export function setCodexUsageCommandRunnerForTest(runner: UsageCommandRunner | null): void {
  commandRunner = runner ?? runCodexUsageCommand;
}

export async function startCodexUsageJob(args: {
  providerName: string;
  cwd: string;
  routing: RoutingContext;
}): Promise<CodexUsageJob | null> {
  if (args.providerName.toLowerCase() !== 'codex') return null;

  const id = generateId();
  const pre = await captureSnapshot('pre', id, args.cwd);
  const prePath = writeSnapshot(args.cwd, id, 'pre', pre);
  log(`pre usage snapshot stored: ${prePath}`);
  return { id, cwd: args.cwd, routing: args.routing, prePath, pre };
}

export async function finishCodexUsageJob(job: CodexUsageJob | null): Promise<CodexUsageDelta | null> {
  if (!job) return null;

  const post = await captureSnapshot('post', job.id, job.cwd);
  const postPath = writeSnapshot(job.cwd, job.id, 'post', post);
  const delta = calculateUsageDelta(job.pre, post, job.prePath, postPath);
  writeSnapshot(job.cwd, job.id, 'delta', {
    schema_version: 'codex-usage-delta.v1',
    ...delta,
    calculated_at: new Date().toISOString(),
  });
  writeCodexRemainingToStore(job.cwd, delta);
  reportUsageDelta(job.routing, delta, job.cwd);
  log(`post usage snapshot stored: ${postPath}`);
  return delta;
}

/**
 * Persist this job's weekly rate-limit remaining into the shared usage store so
 * a deepseek agent can show codex remaining usage without calling the codex
 * bridge. Best-effort: a store write failure never fails the job.
 */
function writeCodexRemainingToStore(cwd: string, delta: CodexUsageDelta): void {
  try {
    const usedPercent = delta.current_values?.['snapshot.rateLimits.rateLimits.primary.usedPercent'];
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return;
    updateCodexRow(cwd, {
      weekly_limit_used_percent: usedPercent,
      weekly_limit_remaining_percent: Math.max(0, 100 - usedPercent),
      captured_at: new Date().toISOString(),
    });
  } catch (err) {
    log(`codex usage store update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function calculateUsageDelta(
  pre: CodexUsageSnapshot,
  post: CodexUsageSnapshot,
  prePath: string,
  postPath: string,
): CodexUsageDelta {
  const deltas: Record<string, number> = {};
  for (const [key, postValue] of Object.entries(post.numeric_values)) {
    const preValue = pre.numeric_values[key];
    if (preValue === undefined) continue;
    const delta = postValue - preValue;
    if (Number.isFinite(delta)) deltas[key] = delta;
  }

  return {
    job_id: pre.job_id,
    pre_path: prePath,
    post_path: postPath,
    command: post.command,
    deltas,
    current_values: post.numeric_values,
    unavailable_reason: buildUnavailableReason(pre, post, deltas),
  };
}

async function captureSnapshot(phase: 'pre' | 'post', jobId: string, cwd: string): Promise<CodexUsageSnapshot> {
  const command = getUsageCommand();
  let result: Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>;
  try {
    result = await commandRunner(command, cwd);
  } catch (err) {
    result = {
      exit_code: null,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const parsed = parseJson(result.stdout);
  return {
    schema_version: 'codex-usage-snapshot.v1',
    phase,
    job_id: jobId,
    captured_at: new Date().toISOString(),
    command,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    parsed_json: parsed,
    numeric_values: parsed === undefined ? {} : flattenNumericValues(parsed),
  };
}

function getUsageCommand(): string[] {
  const configured = process.env.NANOCLAW_CODEX_USAGE_COMMAND_JSON;
  const configuredUsageReader =
    process.env.NANOCLAW_CODEX_USAGE_READER_COMMAND_JSON ?? process.env.NANOCLAW_USAGE_READER_COMMAND_JSON;
  const parsedConfiguredUsageReader = parseCommandJson(configuredUsageReader);
  if (parsedConfiguredUsageReader) return parsedConfiguredUsageReader;
  const usageReaderCommand = resolveUsageReaderCommand();
  if (usageReaderCommand) return usageReaderCommand;
  const parsedConfigured = parseCommandJson(configured);
  if (parsedConfigured) return parsedConfigured;
  if (process.env.NANOCLAW_USAGE_READER_BRIDGE_URL) return [...HOST_USAGE_READER_BRIDGE_COMMAND];
  return [...FALLBACK_APP_SERVER_USAGE_COMMAND];
}

function parseCommandJson(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string')) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveUsageReaderCommand(): string[] | undefined {
  for (const root of USAGE_READER_ROOTS) {
    const command = commandForUsageReaderRoot(root);
    if (command) return command;
  }
  return undefined;
}

function commandForUsageReaderRoot(root: string): string[] | undefined {
  try {
    const stat = fs.statSync(root);
    if (stat.isFile()) return commandForExecutableOrScript(root);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const packageBin = commandFromPackageJson(root);
  if (packageBin) return packageBin;

  for (const relative of [
    'nanoclaw-usage-reader',
    'bin/nanoclaw-usage-reader',
    'cli.mjs',
    'index.mjs',
    'dist/cli.mjs',
    'dist/index.mjs',
    'cli.js',
    'index.js',
    'dist/cli.js',
    'dist/index.js',
  ]) {
    const candidate = path.join(root, relative);
    if (fs.existsSync(candidate)) return commandForExecutableOrScript(candidate);
  }
  return undefined;
}

function commandFromPackageJson(root: string): string[] | undefined {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['nanoclaw-usage-reader'];
    if (typeof bin !== 'string' || bin.length === 0) return undefined;
    return commandForExecutableOrScript(path.join(root, bin));
  } catch {
    return undefined;
  }
}

function commandForExecutableOrScript(filePath: string): string[] {
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ['node', filePath];
  return [filePath];
}

function runCodexUsageCommand(
  command: string[],
  cwd: string,
): Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>> {
  if (shouldUseHostUsageReaderBridge(command)) return runHostUsageReaderBridge();
  if (shouldUseAppServerProtocol(command)) return runCodexAppServerUsageCommand(command, cwd);
  return runUsageReaderCommand(command, cwd);
}

function shouldUseHostUsageReaderBridge(command: string[]): boolean {
  return path.basename(command[0] ?? '') === 'nanoclaw-host-usage-reader';
}

async function runHostUsageReaderBridge(): Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>> {
  const url = process.env.NANOCLAW_USAGE_READER_BRIDGE_URL;
  if (!url) return { exit_code: null, stdout: '', stderr: '', error: 'Usage reader bridge URL is not configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOST_USAGE_READER_BRIDGE_TIMEOUT_MS);
  touchHeartbeat();
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal });
    const stdout = await response.text();
    touchHeartbeat();
    if (!response.ok) {
      const parsed = parseJson(stdout) as { error?: unknown } | undefined;
      const detail = parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
      return { exit_code: response.status, stdout, stderr: '', error: `Usage reader bridge: ${detail}` };
    }
    return { exit_code: 0, stdout, stderr: '' };
  } catch (err) {
    return { exit_code: null, stdout: '', stderr: '', error: `Usage reader bridge: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldUseAppServerProtocol(command: string[]): boolean {
  if (process.env.NANOCLAW_CODEX_USAGE_COMMAND_MODE === 'app-server') return true;
  const executable = path.basename(command[0] ?? '');
  return executable === 'nanoclaw-codex-app-server' || executable === 'codex';
}

function runUsageReaderCommand(
  command: string[],
  cwd: string,
): Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>> {
  const [bin, ...args] = command;
  touchHeartbeat();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: SNAPSHOT_TIMEOUT_MS,
        maxBuffer: SNAPSHOT_MAX_BUFFER,
        env: { ...process.env, TERM: process.env.TERM === 'dumb' ? 'xterm-256color' : process.env.TERM },
      },
      (error, stdout, stderr) => {
        touchHeartbeat();
        const maybeCode =
          error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({
          exit_code: maybeCode ?? (error ? null : 0),
          stdout,
          stderr,
          error: error ? error.message : undefined,
        });
      },
    );
  });
}

function runCodexAppServerUsageCommand(
  command: string[],
  cwd: string,
): Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>> {
  const [bin, ...args] = command;
  let stderr = '';
  let settled = false;
  let child: ReturnType<typeof spawn> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  touchHeartbeat();
  return new Promise((resolve) => {
    const settle = (result: Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      touchHeartbeat();
      if (child && !child.killed) child.kill('SIGTERM');
      resolve(result);
    };

    const send = (message: unknown): void => {
      child?.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TERM: process.env.TERM === 'dumb' ? 'xterm-256color' : process.env.TERM },
      });
    } catch (err) {
      settle({
        exit_code: null,
        stdout: '',
        stderr,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    timeout = setTimeout(() => {
      settle({
        exit_code: null,
        stdout: '',
        stderr,
        error: `Codex usage request timed out after ${SNAPSHOT_TIMEOUT_MS}ms`,
      });
    }, SNAPSHOT_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > SNAPSHOT_MAX_BUFFER) stderr = stderr.slice(-SNAPSHOT_MAX_BUFFER);
    });

    child.on('error', (err) => {
      settle({ exit_code: null, stdout: '', stderr, error: err.message });
    });

    child.on('close', (code) => {
      if (!settled) {
        settle({
          exit_code: code,
          stdout: '',
          stderr,
          error: `Codex usage command exited before returning usage${code === null ? '' : ` (code ${code})`}`,
        });
      }
    });

    if (!child.stdin || !child.stdout) {
      settle({ exit_code: null, stdout: '', stderr, error: 'Codex app-server stdio pipes were unavailable' });
      return;
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        stderr += `${trimmed}\n`;
        return;
      }

      if (!message || typeof message !== 'object') return;
      const rpc = message as { id?: unknown; result?: unknown; error?: unknown };
      if (rpc.id === 1) {
        send({ method: 'initialized' });
        send({ id: APP_SERVER_USAGE_REQUEST_ID, method: 'account/usage/read', params: null });
        return;
      }

      if (rpc.id === APP_SERVER_USAGE_REQUEST_ID) {
        if (rpc.error) {
          settle({ exit_code: null, stdout: '', stderr, error: JSON.stringify(rpc.error) });
          return;
        }
        settle({ exit_code: 0, stdout: JSON.stringify(rpc.result), stderr });
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'nanoclaw-usage-check', version: '0.0.0' },
        capabilities: null,
      },
    });
  });
}

function writeSnapshot(cwd: string, jobId: string, phase: 'pre' | 'post' | 'delta', data: unknown): string {
  const dir = path.join(cwd, USAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, `${safePathSegment(jobId)}-${phase}.json`);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
  return fullPath;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function parseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lastJsonLine = trimmed
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') || line.startsWith('['));
    if (!lastJsonLine) return undefined;
    try {
      return JSON.parse(lastJsonLine);
    } catch {
      return undefined;
    }
  }
}

function flattenNumericValues(value: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix || 'value'] = value;
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => Object.assign(out, flattenNumericValues(item, `${prefix}[${index}]`)));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, flattenNumericValues(child, childPrefix));
  }
  return out;
}

function buildUnavailableReason(
  pre: CodexUsageSnapshot,
  post: CodexUsageSnapshot,
  deltas: Record<string, number>,
): string | undefined {
  if (Object.keys(deltas).length > 0) return undefined;
  if (pre.error || post.error) {
    return [pre.error && `pre: ${pre.error}`, post.error && `post: ${post.error}`].filter(Boolean).join('; ');
  }
  if (Object.keys(pre.numeric_values).length === 0 || Object.keys(post.numeric_values).length === 0) {
    return 'Codex app-server usage output did not contain comparable numeric JSON fields';
  }
  return 'Codex app-server usage output had no overlapping numeric fields';
}

function reportUsageDelta(routing: RoutingContext, delta: CodexUsageDelta, cwd: string): void {
  if (routing.channelType !== 'discord' || !routing.platformId) {
    log('usage delta not sent to Discord: current routing is not a Discord channel');
    return;
  }
  writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: formatUsageDelta(delta, cwd) }),
  });
}

export function formatUsageDelta(delta: CodexUsageDelta, cwd: string): string {
  const lines = [`Codex usage for job ${delta.job_id}:`];
  const lifetimeTokensDelta = delta.deltas['summary.lifetimeTokens'];
  const weeklyLimitUsed = delta.current_values?.['snapshot.rateLimits.rateLimits.primary.usedPercent'];
  const weeklyLimitDelta = delta.deltas['snapshot.rateLimits.rateLimits.primary.usedPercent'];
  if (typeof lifetimeTokensDelta === 'number' && Number.isFinite(lifetimeTokensDelta) && lifetimeTokensDelta !== 0) {
    lines.push(`- summary.lifetimeTokens: ${formatNumber(lifetimeTokensDelta)}`);
  } else if (typeof weeklyLimitUsed === 'number' && Number.isFinite(weeklyLimitUsed)) {
    const deltaText = typeof weeklyLimitDelta === 'number' && Number.isFinite(weeklyLimitDelta)
      ? `${weeklyLimitDelta >= 0 ? '+' : ''}${formatNumber(weeklyLimitDelta)} percentage points`
      : 'unavailable';
    lines.push(`- Weekly limit usage delta: ${deltaText}`);
  } else if (delta.unavailable_reason) {
    lines.push(`- Usage unavailable: ${delta.unavailable_reason}`);
  } else {
    lines.push('- No measurable Codex token delta detected');
  }
  lines.push(`- pre: ${delta.pre_path}`);
  lines.push(`- post: ${delta.post_path}`);
  // Cross-provider display: append the deepseek balance from shared memory so
  // the codex report also shows deepseek remaining without calling its API.
  lines.push(...formatRemainingUsage(cwd));
  return lines.join('\n');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

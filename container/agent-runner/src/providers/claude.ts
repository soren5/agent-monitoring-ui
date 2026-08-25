import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    // Local calendar date — the fallback `name` above already uses local
    // hours, and the agent navigates conversations/ by these date prefixes.
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function writeMemorySessionHook(hook: MemorySessionHookRegistration): void {
  const configDir = claudeConfigDir();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });

  const parsed: unknown = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
  if (!isRecord(parsed)) throw new Error(`${settingsFile} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${settingsFile} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${settingsFile} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    };
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    writeMemorySessionHook(hook);
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    const providerModel = this.model;
    const providerEffort = this.effort;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      const telemetryState = createClaudeTelemetryState(providerModel, providerEffort);
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield normalized telemetry for every SDK event while preserving the
        // legacy result/progress path below byte-for-byte.
        for (const event of translateClaudeTelemetryMessage(message as unknown as ClaudeSdkFixture, telemetryState)) {
          yield event;
        }

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
          yield { type: 'result', text, isError: m.is_error === true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
          // not necessarily an error. `rate_limit_info.status` is usually
          // 'allowed' (here's your remaining headroom). Treating every one of
          // these as a terminal quota error logged a spurious rate-limit line
          // on healthy turns (#3016) — and aborted them outright wherever the
          // classification is acted on. ONLY 'rejected' is an actual block.
          //
          // When it IS rejected the SDK tells us WHY, so we can finally
          // distinguish the two cases properly instead of guessing:
          //   errorCode 'credits_required' / overageDisabledReason
          //   'out_of_credits'  → genuinely out of credits (billing)
          //   otherwise         → a transient window limit that resets.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            // Informational ('allowed' / 'allowed_warning') — never kill the turn.
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // Not a `result`: the poll loop treats result text as the agent's turn
          // output — a synthetic "Context compacted." result has no <message>
          // block, so it triggers the "response was not delivered — please
          // re-send" nudge and the agent duplicates its previous message.
          // Compaction is bookkeeping: log it, count it as activity only.
          log(`Context compacted${detail}.`);
          yield { type: 'activity' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

export interface ClaudeSdkFixture {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; model?: string; content?: unknown[]; usage?: Record<string, number> };
  event?: { type?: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown> };
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
  summary?: string;
  preceding_tool_use_ids?: string[];
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  usage?: Record<string, number>;
  errors?: string[];
  result?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface ClaudeTelemetryState {
  model?: string;
  effort?: string;
  sessionId?: string;
  reasoning: 'full' | 'activity_only' | 'none' | 'unknown';
  blocks: Map<number, { id?: string; name?: string; kind: 'tool' | 'reasoning' | 'text' | 'other' }>;
  startedTools: Set<string>;
}

export function createClaudeTelemetryState(model?: string, effort?: string): ClaudeTelemetryState {
  return {
    model,
    effort,
    reasoning: effort === 'none' ? 'none' : 'unknown',
    blocks: new Map(),
    startedTools: new Set(),
  };
}

export function translateClaudeTelemetryMessage(
  message: ClaudeSdkFixture,
  state: ClaudeTelemetryState,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if (message.session_id) state.sessionId = message.session_id;
  const model = message.message?.model || state.model;
  if (model) state.model = model;
  const provenance = claudeProvenance(state, message.uuid);
  events.push({ type: 'activity', label: claudeActivityLabel(message), status: 'in_progress', provenance });

  if (message.type === 'system' && message.subtype === 'init') {
    events.push({ type: 'capability', reasoning: state.reasoning, toolProgress: true, provenance });
    events.push({ type: 'status', status: 'starting', activity: 'Claude session initialized', provenance });
  } else if (message.type === 'system' && message.subtype === 'status') {
    const status = message.status;
    events.push({
      type: 'status',
      status: status === null ? 'in_progress' : status === 'compacting' ? 'in_progress' : 'waiting',
      activity: typeof status === 'string' ? `Claude ${status}` : 'Claude working',
      provenance,
    });
  } else if (message.type === 'stream_event') {
    translateClaudeStreamEvent(message, state, events);
  } else if (message.type === 'assistant') {
    translateClaudeAssistantMessage(message, state, events);
    if (typeof message.error === 'string') {
      events.push({
        type: 'error',
        message: redactClaudeTelemetry(message.error),
        retryable: message.error === 'rate_limit' || message.error === 'overloaded' || message.error === 'server_error',
        classification: classifyClaudeTelemetryError(message.error),
        code: message.error,
        provenance,
      });
    }
  } else if (message.type === 'user') {
    translateClaudeToolResults(message, state, events);
  } else if (message.type === 'tool_progress' && message.tool_use_id) {
    events.push({
      type: 'tool',
      phase: 'progress',
      name: safeClaudeLabel(message.tool_name, 'tool'),
      toolCallId: message.tool_use_id,
      detail: { elapsedSeconds: message.elapsed_time_seconds },
      provenance: claudeProvenance(state, message.tool_use_id),
    });
  } else if (message.type === 'tool_use_summary') {
    for (const id of message.preceding_tool_use_ids ?? []) {
      events.push({
        type: 'tool',
        phase: 'progress',
        name: 'tool',
        toolCallId: id,
        detail: { summary: redactClaudeTelemetry(message.summary ?? '') },
        provenance: claudeProvenance(state, id),
      });
    }
  } else if (message.type === 'system' && message.subtype === 'thinking_tokens') {
    if (state.reasoning === 'unknown') {
      state.reasoning = 'activity_only';
      events.push({ type: 'capability', reasoning: 'activity_only', toolProgress: true, provenance });
    }
    events.push({
      type: 'reasoning',
      availability: 'activity_only',
      provenance,
    });
  } else if (message.type === 'result') {
    if (message.is_error) {
      const rawError = message.errors?.join('\n') || 'Claude turn failed';
      events.push({
        type: 'error',
        message: redactClaudeTelemetry(rawError),
        retryable: false,
        classification: classifyClaudeTelemetryError(rawError),
        provenance,
      });
    }
    const usage = message.usage;
    if (usage) {
      const promptTokens = numericToken(usage.input_tokens);
      const completionTokens = numericToken(usage.output_tokens);
      events.push({
        type: 'usage',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      });
    }
    events.push({
      type: 'status',
      status: message.is_error ? 'failed' : 'idle',
      activity: message.is_error ? 'Claude turn failed' : 'Claude turn completed',
      provenance,
    });
  }
  return events;
}

function translateClaudeStreamEvent(
  message: ClaudeSdkFixture,
  state: ClaudeTelemetryState,
  events: ProviderEvent[],
): void {
  const event = message.event ?? {};
  const index = typeof event.index === 'number' ? event.index : -1;
  const provenance = claudeProvenance(state, message.uuid);
  if (event.type === 'content_block_start') {
    const block = event.content_block ?? {};
    const blockType = typeof block.type === 'string' ? block.type : 'other';
    if (blockType === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : undefined;
      const name = safeClaudeLabel(block.name, 'tool');
      state.blocks.set(index, { id, name, kind: 'tool' });
      if (id && !state.startedTools.has(id)) {
        state.startedTools.add(id);
        events.push({
          type: 'tool',
          phase: 'start',
          name,
          toolCallId: id,
          detail: message.parent_tool_use_id ? { parentToolCallId: message.parent_tool_use_id } : undefined,
          provenance: claudeProvenance(state, id),
        });
      }
    } else if (blockType === 'thinking') {
      state.blocks.set(index, { kind: 'reasoning' });
      upgradeClaudeReasoning(state, events, 'full', provenance);
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      if (thinking)
        events.push({ type: 'reasoning', availability: 'full', content: redactClaudeTelemetry(thinking), provenance });
    } else if (blockType === 'redacted_thinking') {
      state.blocks.set(index, { kind: 'reasoning' });
      upgradeClaudeReasoning(state, events, 'activity_only', provenance);
      events.push({ type: 'reasoning', availability: 'activity_only', provenance });
    } else {
      state.blocks.set(index, { kind: blockType === 'text' ? 'text' : 'other' });
    }
  } else if (event.type === 'content_block_delta') {
    const delta = event.delta ?? {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      events.push({
        type: 'output',
        text: redactClaudeTelemetry(delta.text),
        format: 'markdown',
        partial: true,
        provenance,
      });
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      upgradeClaudeReasoning(state, events, 'full', provenance);
      events.push({
        type: 'reasoning',
        availability: 'full',
        content: redactClaudeTelemetry(delta.thinking),
        provenance,
      });
    }
  } else if (event.type === 'content_block_stop') {
    const block = state.blocks.get(index);
    if (block?.kind === 'tool' && block.id) {
      events.push({
        type: 'tool',
        phase: 'progress',
        name: block.name ?? 'tool',
        toolCallId: block.id,
        detail: { summary: 'input accepted' },
        provenance: claudeProvenance(state, block.id),
      });
    }
    state.blocks.delete(index);
  }
}

function translateClaudeAssistantMessage(
  message: ClaudeSdkFixture,
  state: ClaudeTelemetryState,
  events: ProviderEvent[],
): void {
  const content = message.message?.content ?? [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({
        type: 'output',
        text: redactClaudeTelemetry(block.text),
        format: 'markdown',
        partial: false,
        provenance: claudeProvenance(state, message.uuid),
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const provenance = claudeProvenance(state, message.uuid);
      upgradeClaudeReasoning(state, events, 'full', provenance);
      events.push({
        type: 'reasoning',
        availability: 'full',
        content: redactClaudeTelemetry(block.thinking),
        provenance,
      });
    } else if (block.type === 'redacted_thinking') {
      const provenance = claudeProvenance(state, message.uuid);
      upgradeClaudeReasoning(state, events, 'activity_only', provenance);
      events.push({ type: 'reasoning', availability: 'activity_only', provenance });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && !state.startedTools.has(block.id)) {
      state.startedTools.add(block.id);
      events.push({
        type: 'tool',
        phase: 'start',
        name: safeClaudeLabel(block.name, 'tool'),
        toolCallId: block.id,
        detail: message.parent_tool_use_id ? { parentToolCallId: message.parent_tool_use_id } : undefined,
        provenance: claudeProvenance(state, block.id),
      });
    }
  }
}

function translateClaudeToolResults(
  message: ClaudeSdkFixture,
  state: ClaudeTelemetryState,
  events: ProviderEvent[],
): void {
  const content = message.message?.content ?? [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    events.push({
      type: 'tool',
      phase: 'complete',
      name: 'tool',
      toolCallId: block.tool_use_id,
      detail: { status: block.is_error === true ? 'failed' : 'completed' },
      provenance: claudeProvenance(state, block.tool_use_id),
    });
  }
}

function upgradeClaudeReasoning(
  state: ClaudeTelemetryState,
  events: ProviderEvent[],
  availability: 'full' | 'activity_only',
  provenance: NonNullable<Extract<ProviderEvent, { type: 'activity' }>['provenance']>,
): void {
  if (state.reasoning === 'full' || state.reasoning === availability) return;
  state.reasoning = availability;
  events.push({ type: 'capability', reasoning: availability, toolProgress: true, provenance });
}

function claudeProvenance(state: ClaudeTelemetryState, itemId?: string) {
  return {
    provider: 'claude',
    ...(state.model ? { model: state.model } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(itemId ? { itemId } : {}),
  };
}

function classifyClaudeTelemetryError(value: string): string | undefined {
  if (/billing|credit|quota|budget/i.test(value)) return 'quota';
  if (/auth|oauth|credential|api.?key/i.test(value)) return 'auth';
  if (/rate.?limit|overloaded|server.?error/i.test(value)) return 'rate_limit';
  if (/permission|denied/i.test(value)) return 'permission';
  return undefined;
}

function claudeActivityLabel(message: ClaudeSdkFixture): string {
  if (message.type === 'stream_event') return 'Claude streaming';
  if (message.type === 'tool_progress' || message.type === 'tool_use_summary') return 'Claude tool activity';
  if (message.subtype === 'thinking_tokens') return 'Claude reasoning';
  return 'Claude provider activity';
}

function safeClaudeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' ? redactClaudeTelemetry(value).slice(0, 120) : fallback;
}

function numericToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Telemetry-only redaction. Never mutates the SDK result delivered to users. */
export function redactClaudeTelemetry(text: string): string {
  return text
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 2_000);
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));

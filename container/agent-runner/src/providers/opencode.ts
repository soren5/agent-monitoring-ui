/**
 * opencode provider — drives the opencode harness headlessly as the agent loop.
 *
 * The runner spawns `opencode serve` (unsecured: the host's OPENCODE_SERVER_PASSWORD
 * is never inherited — the container runs its own server bound to loopback) and
 * talks to it over the official `@opencode-ai/sdk` client. opencode owns the
 * agentic loop: model selection, tool selection (read/bash/edit/write + MCP), and
 * session continuity. This provider is the bridge between that loop and the
 * poll-loop's AgentProvider contract.
 *
 * Continuation: the stored continuation token is the opencode session id. A
 * fresh query resumes that session (opencode keeps its own history server-side),
 * so multi-turn chats continue the same thread across container respawns.
 *
 * Events: the /event SSE stream yields message.part.updated deltas; text parts
 * accumulate into the final result, reasoning parts surface as activity. The
 * turn ends on session.idle. Permission requests are auto-DENIED by default —
 * a local harness agent must not silently escalate (matches the specialist
 * persona's no-host-management rule); NanoClaw MCP tools gate at the host.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import { createOpencodeClient } from '@opencode-ai/sdk/client';
import type { Event, Permission } from '@opencode-ai/sdk/client';

import { registerProvider } from './provider-registry.js';
import { archiveProviderExchange } from './exchange-archive.js';
import '../mcp-tools/core.js';
import '../mcp-tools/interactive.js';
import '../mcp-tools/agents.js';
import '../mcp-tools/factory.js';
import '../mcp-tools/repository.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

const DEFAULT_MODEL = 'google/gemma-4-12b-qat';
const MODEL_BRIDGE_BASE = 'http://local-model.bridge:1234/v1';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

/**
 * Map a NanoClaw model id to the opencode provider + endpoint it should run
 * through. opencode owns the agentic loop (read/bash/edit/write tools); the
 * model rides either the local LM Studio bridge or DeepSeek's API via the
 * OneCLI gateway proxy (deepseek stays OUT of NO_PROXY so the proxy injects
 * the credential, exactly like the native deepseek provider).
 */
function modelHarness(model: string): { providerID: string; modelID: string; baseURL: string } {
  if (model === 'deepseek-v4-flash') {
    return { providerID: 'deepseek', modelID: 'deepseek-v4-flash', baseURL: DEEPSEEK_BASE };
  }
  return { providerID: 'lmstudio', modelID: model, baseURL: MODEL_BRIDGE_BASE };
}

/** Provider-side diagnostics — prefixed so they're greppable in container logs. */
function log(msg: string): void {
  console.error(`[opencode] ${msg}`);
}

/**
 * Run `fn` with the egress HTTP proxy disabled for loopback. The container's
 * egress lockdown sets NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY, and undici
 * honors it for every request — including localhost. opencode's harness
 * server binds loopback, so requests to it must bypass the proxy or the
 * connection dies with "Empty reply"/"socket closed".
 */
function withProxyBypass<T>(fn: () => T): T {
  const saved: Array<[string, string | undefined]> = [];
  const overrides: Record<string, string | undefined> = {
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  for (const [k, v] of Object.entries(overrides)) {
    saved.push([k, process.env[k]]);
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface OpencodeServerHandle {
  url: string;
  close: () => void;
}

export interface OpencodeRuntimeDeps {
  createServer: (port: number, config: unknown) => Promise<OpencodeServerHandle>;
}

const defaultRuntimeDeps: OpencodeRuntimeDeps = {
  async createServer(port: number, config: unknown): Promise<OpencodeServerHandle> {
    // Spawn opencode serve directly so we control the args (--offline skips
    // the models.dev / npm-plugin network init that egress lockdown blocks)
    // and the env (drop the desktop app's server password + the egress proxy
    // for loopback).
    return new Promise<OpencodeServerHandle>((resolve, reject) => {
      // --pure: run without external plugins — the npm-plugin install would
      // otherwise try to reach registry.npmjs.org, which egress lockdown blocks.
      const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--pure'];
      if (config) process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      const child = spawn('opencode', args, {
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: '',
          OPENCODE_SERVER_USERNAME: 'opencode',
          NO_PROXY: 'local-model.bridge,localhost,127.0.0.1',
          no_proxy: 'local-model.bridge,localhost,127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let errOut = '';
      const onData = (chunk: Buffer): void => {
        out += chunk.toString();
        const m = out.match(/listening on (https?:\/\/[^\s]+)/);
        if (m) {
          resolve({ url: m[1], close: () => child.kill() });
          child.stdout?.removeAllListeners('data');
          child.stderr?.removeAllListeners('data');
        }
      };
      const onErr = (chunk: Buffer): void => {
        errOut += chunk.toString();
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onErr);
      child.on('error', (err) => reject(err));
      child.on('exit', (code) => {
        log(`opencode serve exited code=${code} stderr=${errOut.slice(-300)}`);
        reject(new Error(`opencode serve exited ${code}: ${errOut.slice(-200)}`));
      });
      setTimeout(() => reject(new Error(`opencode serve startup timed out: ${out.slice(-200)}`)), 20_000);
    });
  },
};

function classifyError(message: string): string | undefined {
  if (/auth|api key|unauthorized|login|credential/i.test(message)) return 'auth';
  if (/quota|rate limit|insufficient|billing|credit/i.test(message)) return 'quota';
  if (/sandbox|permission|denied/i.test(message)) return 'sandbox';
  return undefined;
}

export class OpencodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly model: string;
  private readonly runtime: OpencodeRuntimeDeps;
  private readonly serverConfig: Record<string, unknown>;
  private readonly harness: { providerID: string; baseURL: string };
  /** Reasoning captured for the most recently completed turn. */
  private lastReasoning = '';

  constructor(options: ProviderOptions = {}, runtime: OpencodeRuntimeDeps = defaultRuntimeDeps) {
    // opencode owns the agentic loop; the configured model picks the backend
    // (lmstudio bridge for local models, deepseek via the gateway proxy).
    const raw = options.model || DEFAULT_MODEL;
    const { providerID, modelID, baseURL } = modelHarness(raw);
    this.model = modelID;
    this.runtime = runtime;
    this.harness = { providerID, baseURL };

    // opencode config injected via OPENCODE_CONFIG_CONTENT:
    //  - the provider for this model's backend
    //  - a minimal permission policy. File and bash operations are left to the
    //    container mounts: NanoClaw mounts only the agent workspace and any
    //    assigned repo worktree read-write, everything else read-only, so the
    //    harness can freely read/edit/run inside what is mounted and physically
    //    cannot touch anything else. The only policy kept here is for actions
    //    the mounts don't cover: no web fetch/search, no user questions, and a
    //    doom-loop guard. The `harness` option distinguishes specialist
    //    (read-only) from coding agents only at the instruction level; both rely
    //    on mounts for the actual filesystem boundary.
    this.serverConfig = {
      provider: {
        [providerID]: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL },
          models: {
            [modelID]: { name: modelID },
          },
        },
      },
      permission: {
        // Mounts are the boundary: NanoClaw mounts only the agent workspace and
        // any repo worktree read-write, and everything else read-only. Allow the
        // harness full use of what is mounted; no path policy here.
        read: 'allow',
        edit: 'allow',
        bash: 'allow',
        webfetch: 'deny',
        websearch: 'deny',
        question: 'deny',
        doom_loop: 'ask',
        // external_directory is left at opencode's default ('ask'), so anything
        // outside the harness working directory surfaces a request the provider
        // auto-denies — belt-and-suspenders on top of the mount boundary.
      },
      mcp: {
        nanoclaw: {
          type: 'local',
          command: ['bun', 'run', '/app/src/mcp-tools/index.ts'],
          enabled: true,
        },
      },
    };
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({
      provider: 'opencode',
      prompt: exchange.prompt,
      result: exchange.result,
      continuation: exchange.continuation,
      status: exchange.status,
      reasoning: this.lastReasoning || exchange.reasoning,
    });
  }

  registerMemorySessionHook(): void {}

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*not found|invalid session|no session/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const self = this;
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let active: { handle: OpencodeServerHandle; sessionId: string } | null = null;
    let wakeActiveTurn: (() => void) | null = null;

    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      log('spawning opencode serve (offline)');
      const handle = await self.runtime.createServer(0, self.serverConfig);
      // The egress proxy (NODE_USE_ENV_PROXY) must never intercept loopback
      // traffic to the harness server — wrap fetch so the request bypasses it.
      const client = createOpencodeClient({
        baseUrl: handle.url,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          withProxyBypass(() => fetch(input, init)),
      });

      // Resolve session: reuse the continuation (resume) or create fresh.
      let sessionId: string;
      try {
        if (input.continuation) {
          const existing = await client.session.get({ path: { id: input.continuation } });
          sessionId = existing.data?.id ?? input.continuation;
          log(`resuming opencode session ${sessionId}`);
        } else {
          const created = await client.session.create({ body: {}, query: { directory: input.cwd } });
          if (!created.data?.id) throw new Error('opencode: session create returned no id');
          sessionId = created.data.id;
          log(`created opencode session ${sessionId}`);
        }
      } catch (err) {
        throw new Error(`opencode: failed to init session: ${err instanceof Error ? err.message : String(err)}`);
      }
      active = { handle, sessionId };
      let initYielded = false;

      // Pick the model + provider for this model's backend. opencode defaults
      // to the session's last model; force the configured one so a resumed
      // session doesn't drift back to a cloud default.
      const providerID = self.harness.providerID;
      const modelID = self.model;

      try {
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;
          yield* runOneTurn(
            client,
            sessionId,
            text,
            input.systemContext?.instructions,
            { providerID, modelID },
            input.cwd,
            () => {
              if (!initYielded) {
                initYielded = true;
                return { type: 'init' as const, continuation: sessionId };
              }
              return null;
            },
            () => aborted,
            (waker) => {
              wakeActiveTurn = waker;
            },
            (reasoning) => {
              self.lastReasoning = reasoning;
            },
          );
        }
      } finally {
        wakeActiveTurn = null;
        active = null;
        handle.close();
      }
    }

    return {
      push: (message) => {
        if (active && active.sessionId) {
          pending.push(message);
          wake();
          return;
        }
        pending.push(message);
        wake();
      },
      end: () => {
        ended = true;
        wake();
      },
      abort: () => {
        aborted = true;
        wakeActiveTurn?.();
        wake();
      },
      events: gen(),
    };
  }
}

async function* runOneTurn(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  inputText: string,
  systemInstructions: string | undefined,
  model: { providerID: string; modelID: string },
  cwd: string,
  markInit: () => { type: 'init'; continuation: string } | null,
  isAborted: () => boolean,
  setAbortWaker: (waker: (() => void) | null) => void,
  setReasoning: (reasoning: string) => void,
): AsyncGenerator<ProviderEvent> {
  const state: { error: Error | null } = { error: null };
  let resultText = '';
  let reasoningText = '';
  let turnDone = false;
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };
  setAbortWaker(kick);

  const init = markInit();
  if (init) buffer.push(init);

  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;

  // Stream subscription — the turn's completion is signalled by session.idle
  // or a session.error event targeting this session. The SSE client returns an
  // async generator; a background consumer drains it into the event buffer.
  let sseStream: AsyncGenerator<Event, unknown, unknown> | null = null;
  let consumerDone = false;
  try {
    const sse = await client.event.subscribe({ query: { directory: cwd } });
    sseStream = sse.stream as unknown as AsyncGenerator<Event, unknown, unknown>;
  } catch (err) {
    state.error = new Error(`opencode: event stream failed: ${err instanceof Error ? err.message : String(err)}`);
    turnDone = true;
    consumerDone = true;
  }

  const handleEvent = (e: Event): void => {
    buffer.push({ type: 'activity' });
    switch (e.type) {
      case 'message.part.updated': {
        const part = e.properties?.part;
        if (part?.type === 'text' && typeof part.text === 'string') {
          resultText = part.text;
        } else if (part?.type === 'reasoning' && typeof part.text === 'string') {
          reasoningText = part.text;
        }
        break;
      }
      case 'message.updated': {
        // Fallback: some harness versions emit the assembled message here.
        const content = (e as unknown as { properties?: { message?: { parts?: Array<{ type?: string; text?: string }> } } })
          .properties?.message?.parts;
        if (Array.isArray(content)) {
          const text = content.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
          if (text) resultText = text;
        }
        break;
      }
      case 'session.status': {
        const status = e.properties?.status;
        if (status && status.type !== 'busy') {
          log(`turn event session.status=${status.type}`);
          buffer.push({ type: 'progress', message: `status: ${status.type}` });
        }
        break;
      }
      case 'session.idle': {
        if (e.properties?.sessionID === sessionId) {
          log('turn event session.idle — turn complete');
          turnDone = true;
        }
        break;
      }
      case 'session.error': {
        const msg = (e.properties as unknown as { error?: { message?: string } } | undefined)?.error?.message;
        if (e.properties?.sessionID === sessionId) {
          log(`turn event session.error: ${msg || 'unknown'} full=${JSON.stringify(e).slice(0, 600)}`);
          state.error = new Error(msg || `opencode turn failed: ${JSON.stringify(e.properties).slice(0, 300)}`);
          turnDone = true;
        }
        break;
      }
      case 'permission.updated': {
        // Auto-deny permission requests — never let a local agent escalate.
        const p = e.properties as Permission;
        log(`permission request denied: ${p.title}`);
        void client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: p.id },
          body: { response: 'reject' },
        }).catch(() => {});
        break;
      }
      default:
        break;
    }
    kick();
  };

  if (sseStream) {
    const consumer = (async (): Promise<void> => {
      try {
        for await (const event of sseStream) {
          if (isAborted()) return;
          handleEvent(event);
        }
      } catch (err) {
        if (!isAborted()) {
          state.error = new Error(`opencode: event stream error: ${err instanceof Error ? err.message : String(err)}`);
          turnDone = true;
          kick();
        }
      } finally {
        consumerDone = true;
      }
    })();
    // Keep the consumer running for the life of this turn.
    void consumer;
  }

  try {
    log(`prompting session ${sessionId} (msg ${messageId})`);
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        messageID: messageId,
        model,
        system: systemInstructions,
        parts: [{ type: 'text', text: inputText }],
      },
    });
    log(`promptAsync accepted; waiting for events`);

    // Drain until the turn completes (session.idle / error / timeout / abort).
    while (!turnDone && !isAborted()) {
      while (buffer.length > 0) yield buffer.shift()!;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }
    while (buffer.length > 0) yield buffer.shift()!;

    if (isAborted()) return;

    if (state.error) {
      yield {
        type: 'error',
        message: state.error.message,
        retryable: false,
        classification: classifyError(state.error.message),
      };
      throw state.error;
    }

    setReasoning(reasoningText);
    yield { type: 'result', text: resultText || null };
  } catch (err) {
    if (isAborted()) return;
    if (state.error) {
      yield {
        type: 'error',
        message: state.error.message,
        retryable: false,
        classification: classifyError(state.error.message),
      };
      throw state.error;
    }
    throw err;
  } finally {
    setAbortWaker(null);
    if (sseStream) {
      try {
        await sseStream.return?.({} as never);
      } catch {
        // ignore
      }
    }
    void consumerDone;
  }
}

registerProvider('opencode', (opts) => new OpencodeProvider(opts));

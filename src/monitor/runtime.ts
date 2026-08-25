import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type net from 'net';
import { DATA_DIR } from '../config.js';
import { wakeContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { findSessionByAgentGroup, getActiveSessions } from '../db/sessions.js';
import { DEFAULT_AGENT_PROVIDER } from '../config.js';
import { log } from '../log.js';
import { openOutboundDb, writeSessionMessage } from '../session-manager.js';
import { MessageCommandHandler, SqliteCommandStore } from './commands.js';
import { MonitorPublisher, ProgressCoalescer } from './publisher.js';
import { startMonitorServer, type MonitorAuth, type MonitorGrants } from './transport.js';
import { setRuntimeTelemetrySink } from './telemetry.js';
import { createHostMessageDelivery } from './host-delivery.js';
import { drainRunnerTelemetry, FileTelemetryHighWater } from './runner-telemetry-drainer.js';

export const DEFAULT_MONITOR_SOCKET = path.join(DATA_DIR, 'monitor.sock');
export const DEFAULT_MONITOR_TOKEN_FILE = path.join(DATA_DIR, 'monitor.token');
let server: net.Server | undefined;
let telemetryTimer: NodeJS.Timeout | undefined;
let commandRecoveryTimer: NodeJS.Timeout | undefined;
const telemetryHighWater = new FileTelemetryHighWater(path.join(DATA_DIR, 'monitor-telemetry-high-water.json'));
export const monitorPublisher = new MonitorPublisher();
let progressCoalescer: ProgressCoalescer | undefined;

export class FileTokenAuth implements MonitorAuth {
  constructor(private readonly tokens: ReadonlyMap<string, MonitorGrants>) {}
  authenticate(token: string): MonitorGrants | undefined {
    return this.tokens.get(token);
  }
  static ownerToken(file = DEFAULT_MONITOR_TOKEN_FILE): FileTokenAuth {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file))
      fs.writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    const token = fs.readFileSync(file, 'utf8').trim();
    return new FileTokenAuth(new Map([[token, { monitor: true, privateReasoning: true, message: true }]]));
  }
}

function seedSnapshot(): void {
  const rows = getDb()
    .prepare(
      `SELECT ag.id AS agent_group_id,s.id AS session_id,s.container_status,s.last_active,
       COALESCE(s.agent_provider,cc.provider,?) AS provider,cc.model,cc.effort
       FROM agent_groups ag LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE agent_group_id=ag.id AND status='active' ORDER BY created_at DESC LIMIT 1)
       LEFT JOIN container_configs cc ON cc.agent_group_id=ag.id ORDER BY ag.id`,
    )
    .all(DEFAULT_AGENT_PROVIDER) as Array<{
    agent_group_id: string;
    session_id: string | null;
    container_status: string | null;
    last_active: string | null;
    provider: string | null;
    model: string | null;
    effort: string | null;
  }>;
  for (const row of rows)
    monitorPublisher.publish(
      'agent.upsert',
      row.agent_group_id,
      {
        status: mapPersistedContainerStatus(row.container_status),
        // No blocker source is persisted today. Initial agent registration is
        // the documented authoritative boundary; incremental events preserve
        // this value unless they carry explicit boolean evidence.
        hasBlockers: false,
        reasoningAvailability: seedReasoningAvailability(row.provider, row.effort),
      },
      { sessionId: row.session_id ?? undefined },
    );
}
export function mapPersistedContainerStatus(
  status: string | null,
): 'starting' | 'idle' | 'in_progress' | 'stopping' | 'stopped' | 'failed' | 'unknown' {
  if (!status) return 'stopped';
  if (status === 'running') return 'in_progress';
  if (status === 'idle') return 'idle';
  if (status === 'starting') return 'starting';
  if (status === 'stopping') return 'stopping';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return 'unknown';
}

export function seedReasoningAvailability(
  provider: string | null | undefined,
  effort: string | null | undefined,
): 'none' | 'unknown' {
  if (effort === 'none') return 'none';
  if ((provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase() === 'openai-compatible') return 'none';
  return 'unknown';
}

function isTelemetryDbOperationalError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  return code.startsWith('SQLITE_') || code === 'ENOENT' || code === 'EACCES';
}

export async function startMonitorRuntime(
  socketPath = DEFAULT_MONITOR_SOCKET,
  auth: MonitorAuth = FileTokenAuth.ownerToken(),
): Promise<void> {
  seedSnapshot();
  progressCoalescer = new ProgressCoalescer(monitorPublisher, 5_000);
  setRuntimeTelemetrySink((type, agentGroupId, payload) => {
    progressCoalescer?.push(type, agentGroupId, payload);
  });
  const delivery = createHostMessageDelivery({
    find: findSessionByAgentGroup,
    write: writeSessionMessage,
    wake: wakeContainer,
  });
  const handler = new MessageCommandHandler(new SqliteCommandStore(getDb()), delivery, monitorPublisher);
  await handler.recover();
  commandRecoveryTimer = setInterval(() => {
    void handler.recover().catch((err: unknown) => log.warn('Monitor command recovery failed', { err }));
  }, 5_000);
  server = await startMonitorServer(socketPath, monitorPublisher, handler, auth);
  const drain = () => {
    for (const session of getActiveSessions()) {
      let db;
      try {
        db = openOutboundDb(session.agent_group_id, session.id);
      } catch (err) {
        if (!isTelemetryDbOperationalError(err)) throw err;
        continue;
      }
      try {
        drainRunnerTelemetry(db, session.id, telemetryHighWater, (row) => {
          monitorPublisher.publish(
            row.type,
            session.agent_group_id,
            {
              ...row.payload,
              provenance: row.provenance,
              occurredAt: row.occurredAt,
              schemaVersion: row.schemaVersion,
            },
            { eventId: row.id, sessionId: session.id },
          );
        });
      } catch (err) {
        if (!isTelemetryDbOperationalError(err)) throw err;
        log.warn('Runner telemetry drain failed', { sessionId: session.id, err });
      } finally {
        db.close();
      }
    }
  };
  drain();
  telemetryTimer = setInterval(drain, 1_000);
  log.info('Monitor server listening', { socketPath });
}
export async function stopMonitorRuntime(): Promise<void> {
  setRuntimeTelemetrySink(undefined);
  progressCoalescer?.close();
  progressCoalescer = undefined;
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (commandRecoveryTimer) clearInterval(commandRecoveryTimer);
  commandRecoveryTimer = undefined;
  telemetryTimer = undefined;
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
}

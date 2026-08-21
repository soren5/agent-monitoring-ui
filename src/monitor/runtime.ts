import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type net from 'net';
import { DATA_DIR } from '../config.js';
import { wakeContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import { MessageCommandHandler, SqliteCommandStore } from './commands.js';
import { MonitorPublisher } from './publisher.js';
import { startMonitorServer, type MonitorAuth, type MonitorGrants } from './transport.js';
import { setRuntimeTelemetrySink } from './telemetry.js';
import { createHostMessageDelivery } from './host-delivery.js';

export const DEFAULT_MONITOR_SOCKET = path.join(DATA_DIR, 'monitor.sock');
export const DEFAULT_MONITOR_TOKEN_FILE = path.join(DATA_DIR, 'monitor.token');
let server: net.Server | undefined;
export const monitorPublisher = new MonitorPublisher();

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
      `SELECT ag.id AS agent_group_id,s.id AS session_id,s.container_status,s.last_active FROM agent_groups ag LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE agent_group_id=ag.id AND status='active' ORDER BY created_at DESC LIMIT 1) ORDER BY ag.id`,
    )
    .all() as Array<{
    agent_group_id: string;
    session_id: string | null;
    container_status: string | null;
    last_active: string | null;
  }>;
  for (const row of rows)
    monitorPublisher.publish(
      'agent.upsert',
      row.agent_group_id,
      { status: mapStatus(row.container_status), hasBlockers: false, reasoningAvailability: 'unknown' },
      { sessionId: row.session_id ?? undefined },
    );
}
function mapStatus(
  status: string | null,
): 'starting' | 'idle' | 'in_progress' | 'stopping' | 'stopped' | 'failed' | 'unknown' {
  if (!status) return 'stopped';
  if (status === 'running') return 'in_progress';
  if (status === 'starting') return 'starting';
  if (status === 'stopping') return 'stopping';
  if (status === 'failed') return 'failed';
  return 'unknown';
}

export async function startMonitorRuntime(
  socketPath = DEFAULT_MONITOR_SOCKET,
  auth: MonitorAuth = FileTokenAuth.ownerToken(),
): Promise<void> {
  seedSnapshot();
  setRuntimeTelemetrySink((type, agentGroupId, payload) => {
    monitorPublisher.publish(type, agentGroupId, payload);
  });
  const delivery = createHostMessageDelivery({
    find: findSessionByAgentGroup,
    write: writeSessionMessage,
    wake: wakeContainer,
  });
  const handler = new MessageCommandHandler(new SqliteCommandStore(getDb()), delivery, monitorPublisher);
  server = await startMonitorServer(socketPath, monitorPublisher, handler, auth);
  log.info('Monitor server listening', { socketPath });
}
export async function stopMonitorRuntime(): Promise<void> {
  setRuntimeTelemetrySink(undefined);
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
}

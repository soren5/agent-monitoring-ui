/**
 * active-turns.ts — show which agents have an active (in-progress) turn.
 *
 * An agent is "active" when it has a running container AND a message whose
 * processing claim is still 'processing' (the provider is mid-turn) AND a
 * fresh heartbeat. Idle agents with a running container are shown as idle.
 *
 * Usage:
 *   pnpm exec tsx scripts/active-turns.ts
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { sessionDir } from '../src/session-manager.js';
import { openOutboundDb } from '../src/db/session-db.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'v2-sessions');

interface AgentRow {
  id: string;
  name: string;
  folder: string;
}

interface ClaimRow {
  message_id: string;
  status: string;
  status_changed: string;
}

function containerRunning(folder: string): boolean {
  // Cheap host-side check: any docker container named for this folder is up.
  try {
    const out = execSyncSafe(`docker ps --format '{{.Names}}' | grep -c nanoclaw-v2-${folder} || true`);
    return parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

function execSyncSafe(cmd: string): string {
  // Node's execSync is fine here; scripts already use it (sanity-live-poll).
  const { execSync } = require('child_process');
  try {
    return execSync(cmd, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function activeClaims(agentGroupId: string): Array<{ sessionId: string; claim: ClaimRow }> {
  const agentDir = path.join(SESSIONS_ROOT, agentGroupId);
  if (!fs.existsSync(agentDir)) return [];
  const out: Array<{ sessionId: string; claim: ClaimRow }> = [];
  for (const sessionId of fs.readdirSync(agentDir)) {
    const outboundPath = path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
    if (!fs.existsSync(outboundPath)) continue;
    try {
      // openOutboundDb is readonly + busy_timeout, so it can read the
      // container's live outbound.db (raw better-sqlite3 would hit "locked").
      const db = openOutboundDb(outboundPath);
      const claims = db
        .prepare("SELECT message_id, status, status_changed FROM processing_ack WHERE status = 'processing'")
        .all() as ClaimRow[];
      db.close();
      for (const claim of claims) out.push({ sessionId, claim });
    } catch {
      // Locked / transient — skip.
    }
  }
  return out;
}

function heartbeatAge(agentGroupId: string, sessionId: string): number | null {
  const hb = path.join(SESSIONS_ROOT, agentGroupId, sessionId, '.heartbeat');
  try {
    return Date.now() - fs.statSync(hb).mtimeMs;
  } catch {
    return null;
  }
}

function main(): void {
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
  const agents = db.prepare('SELECT id, name, folder FROM agent_groups ORDER BY name').all() as AgentRow[];

  console.log(`${'AGENT'.padEnd(16)} ${'STATUS'.padEnd(10)} ${'SESSION'.padEnd(28)} ${'SINCE'.padEnd(24)} HEARTBEAT`);
  console.log('-'.repeat(100));

  for (const agent of agents) {
    const claims = activeClaims(agent.id);
    const running = containerRunning(agent.folder);
    if (claims.length === 0 && !running) {
      console.log(`${agent.name.padEnd(16)} ${'idle'.padEnd(10)} —`);
      continue;
    }
    if (claims.length === 0) {
      console.log(`${agent.name.padEnd(16)} ${'idle'.padEnd(10)} (container up, no active claim)`);
      continue;
    }
    for (const { sessionId, claim } of claims) {
      const hbAge = heartbeatAge(agent.id, sessionId);
      const hbText = hbAge === null ? 'no-heartbeat' : `${Math.round(hbAge / 1000)}s`;
      console.log(
        `${agent.name.padEnd(16)} ${'ACTIVE'.padEnd(10)} ${sessionId.padEnd(28)} ${claim.status_changed.padEnd(24)} ${hbText}`,
      );
    }
  }
  db.close();
}

main();

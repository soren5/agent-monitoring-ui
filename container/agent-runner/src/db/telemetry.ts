import { randomUUID } from 'crypto';
import { getOutboundDb } from './connection.js';

export const RUNNER_TELEMETRY_SCHEMA_VERSION = 1;

export function appendRunnerTelemetry(
  type: string,
  payload: Record<string, unknown>,
  provenance: Record<string, unknown>,
): { id: string; seq: number } {
  const db = getOutboundDb();
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const insert = db.transaction(() => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runner_telemetry').get() as { seq: number })
      .seq;
    db.prepare(
      `INSERT INTO runner_telemetry
       (id, seq, occurred_at, schema_version, type, payload_json, provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      seq,
      occurredAt,
      RUNNER_TELEMETRY_SCHEMA_VERSION,
      type,
      JSON.stringify(payload),
      JSON.stringify(provenance),
    );
    return seq;
  });
  return { id, seq: insert() };
}

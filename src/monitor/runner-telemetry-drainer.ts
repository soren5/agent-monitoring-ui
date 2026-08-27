import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type { MonitorEventType } from './protocol.js';
import type { ProgressCoalescer } from './publisher.js';

export interface RunnerTelemetryRow {
  id: string;
  seq: number;
  occurred_at: string;
  schema_version: number;
  type: MonitorEventType;
  payload_json: string;
  provenance_json: string;
}

/** High-water ownership deliberately lives outside the runner-owned DB. */
export interface TelemetryHighWater {
  get(sessionId: string): number;
  set(sessionId: string, sequence: number): void;
}

export type DrainedTelemetrySink = (row: {
  id: string;
  sequence: number;
  occurredAt: string;
  schemaVersion: number;
  type: MonitorEventType;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
}) => void;

/**
 * Read runner telemetry in sequence order without mutating outbound.db.
 * The stable row ID lets a duplicate-aware sink safely accept a replay when
 * the process stops after publish but before the external high-water advances.
 */
export function drainRunnerTelemetry(
  db: Database.Database,
  sessionId: string,
  highWater: TelemetryHighWater,
  sink: DrainedTelemetrySink,
): number {
  let cursor = highWater.get(sessionId);
  let rows: RunnerTelemetryRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, seq, occurred_at, schema_version, type, payload_json, provenance_json
           FROM runner_telemetry WHERE seq > ? ORDER BY seq ASC`,
      )
      .all(cursor) as RunnerTelemetryRow[];
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table: runner_telemetry')) return cursor;
    throw error;
  }
  for (const row of rows) {
    sink({
      id: row.id,
      sequence: row.seq,
      occurredAt: row.occurred_at,
      schemaVersion: row.schema_version,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    });
    cursor = row.seq;
    highWater.set(sessionId, cursor);
  }
  return cursor;
}

/** Route durable runner rows through the same production coalescer as host telemetry. */
export function drainRunnerTelemetryThroughCoalescer(
  db: Database.Database,
  sessionId: string,
  agentGroupId: string,
  highWater: TelemetryHighWater,
  coalescer: ProgressCoalescer,
): number {
  return drainRunnerTelemetry(db, sessionId, highWater, (row) => {
    coalescer.push(
      row.type,
      agentGroupId,
      {
        ...row.payload,
        provenance: row.provenance,
        occurredAt: row.occurredAt,
        schemaVersion: row.schemaVersion,
      },
      { eventId: row.id, sessionId },
    );
  });
}

export class MemoryTelemetryHighWater implements TelemetryHighWater {
  private readonly values = new Map<string, number>();
  get(sessionId: string): number {
    return this.values.get(sessionId) ?? 0;
  }
  set(sessionId: string, sequence: number): void {
    this.values.set(sessionId, sequence);
  }
}

/** Durable host-owned high-water store; never writes the runner database. */
export class FileTelemetryHighWater implements TelemetryHighWater {
  private readonly values: Record<string, number>;
  constructor(private readonly file: string) {
    try {
      this.values = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')
      ) {
        this.values = {};
      } else {
        throw error;
      }
    }
  }
  get(sessionId: string): number {
    return this.values[sessionId] ?? 0;
  }
  set(sessionId: string, sequence: number): void {
    if ((this.values[sessionId] ?? 0) >= sequence) return;
    this.values[sessionId] = sequence;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.values), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
